import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// This server does NOT talk to MongoDB directly. It calls the existing
// webtonative-apis HTTP endpoints, which already implement the real
// business logic (icon/splash generation, dedup, package/platform
// resolution, version numbering) behind `/build-app-request` and
// `/build-status` — the same public endpoints the WebToNative web app
// itself uses. Re-implementing that against Mongo directly would mean
// duplicating (and likely breaking) rules that already exist there.
const API_BASE_URL = (
  process.env.WEBTONATIVE_API_BASE_URL || 'https://api.webtonative.com'
).replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 8787;

// `AppBuildHistory.status` enum values (see src/mongo/schema/AppBuildHistory.ts
// in webtonative-apis) collapsed to the simplified states this MCP server exposes.
const STATUS_MAP: Record<string, 'pending' | 'building' | 'success' | 'failed'> = {
  CAN_GENERATE: 'pending',
  COPY_ASSETS: 'building',
  GENERATE_SPLASH: 'building',
  BUILDING_APP: 'building',
  UPLOADING_APK: 'building',
  IN_PROGRESS: 'building',
  DONE: 'success',
  FAILED: 'failed',
  SYSTEM_ERROR: 'failed',
  CANCELLED: 'failed',
  ACTION_REQUIRED: 'failed',
};

function normalizeUrl(input: string): string {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(candidate).toString();
}

function deriveAppName(websiteUrl: string): string {
  const host = new URL(websiteUrl).hostname.replace(/^www\./, '');
  const label = host.split('.')[0] || host;
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// `/build-app-request` tracks the pending-OTP state server-side in a
// Redis-backed session, keyed by the `w2n.connect.sid` cookie. This
// server has no browser to hold that cookie for the user across the
// generate_app -> verify_build_otp round trip, so it holds it here
// instead, keyed by the email the OTP was sent to. The session's own OTP
// TTL (10 minutes, see verifyOrSendBuildAppOtp in core.service.ts) is
// mirrored so an abandoned entry doesn't linger forever.
const OTP_SESSION_TTL_MS = 10 * 60 * 1000;
const pendingOtpSessions = new Map<string, { cookie: string; expiresAt: number }>();

function storeSessionCookie(emailId: string, cookie: string) {
  pendingOtpSessions.set(emailId, { cookie, expiresAt: Date.now() + OTP_SESSION_TTL_MS });
}

function getSessionCookie(emailId: string): string | null {
  const entry = pendingOtpSessions.get(emailId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingOtpSessions.delete(emailId);
    return null;
  }
  return entry.cookie;
}

function extractSessionCookie(res: Response): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookies.find((c) => c.startsWith('w2n.connect.sid='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

async function apiPost(path: string, body: unknown, cookie?: string) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { json, setCookie: extractSessionCookie(res) };
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  return res.json();
}

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return structuredContent
    ? { content: [{ type: 'text' as const, text }], structuredContent }
    : { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'webtonative-mcp-server',
    version: '1.0.0',
  });

  server.registerTool(
    'generate_app',
    {
      title: 'Generate Android app from a website',
      description:
        'Submit a website URL to start generating a native Android app (APK) for it. ' +
        'Usually returns a buildId immediately — the build itself runs in the background ' +
        'and is not finished yet when this returns. Call check_build_status with the ' +
        'returned buildId to track progress and get the final download link. ' +
        'Occasionally (for a new or unusual-looking email) this instead sends a one-time ' +
        'code to emailId and returns status "otp_required" — in that case, ask the user ' +
        'for the code from their email and call verify_build_otp with it.',
      inputSchema: {
        websiteUrl: z
          .string()
          .describe('The website URL to convert into an Android app, e.g. https://example.com'),
        emailId: z
          .string()
          .email()
          .describe("The user's email address, used to identify the build request."),
        appName: z
          .string()
          .optional()
          .describe('Display name for the app. Defaults to a name derived from the domain.'),
        platform: z
          .enum(['android', 'ios'])
          .optional()
          .describe('Target platform. Only "android" is supported today.'),
      },
      outputSchema: {
        status: z.enum(['queued', 'otp_required']),
        buildId: z.string().optional(),
        emailId: z.string().optional(),
      },
    },
    async ({ websiteUrl, emailId, appName, platform }) => {
      if (platform && platform !== 'android') {
        return errorResult(
          'Only Android app generation is supported right now. iOS support is not available yet.',
        );
      }

      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeUrl(websiteUrl);
      } catch {
        return errorResult(`"${websiteUrl}" is not a valid URL.`);
      }

      const finalAppName = appName?.trim() || deriveAppName(normalizedUrl);

      let response: { json: any; setCookie: string | null };
      try {
        response = await apiPost('/api/v1/build-app-request', {
          appName: finalAppName,
          emailId,
          packageId: 'ANDROID',
          websiteUrl: normalizedUrl,
        });
      } catch (err: any) {
        return errorResult(`Failed to reach WebToNative API: ${err?.message || err}`);
      }

      const { json: result, setCookie } = response;

      if (result?.isSuccess && result?.requestId) {
        // Email/site looked trustworthy enough that the OTP gate was
        // skipped — the build was created directly.
        return textResult(
          `Build started for ${normalizedUrl}. Build ID: ${result.requestId}. ` +
            `Call check_build_status with this buildId to check progress.`,
          { buildId: result.requestId, status: 'queued' },
        );
      }

      if (result?.isSuccess && result?.otpSent) {
        if (!setCookie) {
          return errorResult('OTP was sent but the session could not be tracked. Please retry.');
        }
        storeSessionCookie(emailId, setCookie);
        return textResult(
          `A one-time code was sent to ${emailId}. Ask the user for that code, then call ` +
            `verify_build_otp with emailId "${emailId}" and the code to start the build.`,
          { status: 'otp_required', emailId },
        );
      }

      return errorResult(
        `Could not start the build: ${result?.msg || result?.errorCode || 'unknown error'}`,
      );
    },
  );

  server.registerTool(
    'verify_build_otp',
    {
      title: 'Verify the OTP sent by generate_app',
      description:
        'Completes a build started by generate_app when it returned status "otp_required". ' +
        'Submit the one-time code the user received by email at that emailId to start the build.',
      inputSchema: {
        emailId: z.string().email().describe('The same emailId passed to generate_app.'),
        otp: z.string().describe('The one-time code the user received by email.'),
      },
      outputSchema: {
        buildId: z.string(),
        status: z.literal('queued'),
      },
    },
    async ({ emailId, otp }) => {
      const cookie = getSessionCookie(emailId);
      if (!cookie) {
        return errorResult(
          'No pending build request found for this email (it may have expired after 10 minutes). ' +
            'Call generate_app again to restart.',
        );
      }

      let response: { json: any; setCookie: string | null };
      try {
        response = await apiPost('/api/v1/build-app-request/verify-otp', { otp }, cookie);
      } catch (err: any) {
        return errorResult(`Failed to reach WebToNative API: ${err?.message || err}`);
      }

      const { json: result, setCookie } = response;

      if (result?.isSuccess && result?.requestId) {
        pendingOtpSessions.delete(emailId);
        return textResult(
          `Build started. Build ID: ${result.requestId}. ` +
            `Call check_build_status with this buildId to check progress.`,
          { buildId: result.requestId, status: 'queued' },
        );
      }

      if (result?.errorCode === 'MAX_TRIES_EXCEEDED' || result?.errorCode === 'OTP_SESSION_EXPIRED') {
        pendingOtpSessions.delete(emailId);
      } else if (setCookie) {
        storeSessionCookie(emailId, setCookie);
      }

      return errorResult(
        result?.errorCode === 'INVALID_OTP'
          ? 'That code is incorrect. Ask the user to double check it and try again.'
          : `Could not verify the code: ${result?.errorCode || result?.msg || 'unknown error'}`,
      );
    },
  );

  server.registerTool(
    'check_build_status',
    {
      title: 'Check Android build status',
      description:
        'Check the status of an app build started with generate_app. Status progresses ' +
        'through pending -> building -> success/failed. If the status is not yet ' +
        '"success" or "failed", wait about 15-20 seconds and call this tool again with ' +
        'the same buildId. Once status is "success", downloadUrl is a direct link to the APK.',
      inputSchema: {
        buildId: z.string().describe('The buildId returned by generate_app'),
      },
      outputSchema: {
        status: z.enum(['pending', 'building', 'success', 'failed']),
        downloadUrl: z.string().nullable(),
      },
    },
    async ({ buildId }) => {
      let result: any;
      try {
        result = await apiGet(
          `/api/v1/build-status?appId=${encodeURIComponent(buildId)}&platform=android`,
        );
      } catch (err: any) {
        return errorResult(`Failed to reach WebToNative API: ${err?.message || err}`);
      }

      if (!result?.isSuccess) {
        return errorResult(
          `Could not fetch build status: ${result?.err || result?.message || 'unknown error'}`,
        );
      }

      const history = result.data;
      if (!history) {
        return textResult('Build is queued and has not started yet. Try again shortly.', {
          status: 'pending',
          downloadUrl: null,
        });
      }

      const status = STATUS_MAP[history.status] || 'pending';
      const downloadUrl =
        status === 'success' ? history.androidApkUrl || history.androidAabUrl || null : null;

      let text: string;
      if (status === 'success') {
        text = downloadUrl
          ? `Build complete! Download your APK: ${downloadUrl}`
          : 'Build finished but no download URL was found yet. Try again shortly.';
      } else if (status === 'failed') {
        text = `Build failed${history.failureReason ? `: ${history.failureReason}` : '.'}`;
      } else {
        text = `Build is still in progress (status: ${history.status}). Check again in about 15-20 seconds.`;
      }

      return textResult(text, { status, downloadUrl });
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Error handling MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`WebToNative MCP server listening on port ${PORT}`);
});
