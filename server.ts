import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// This server does NOT talk to MongoDB directly. It calls the existing
// webtonative-apis HTTP endpoints, which already implement the real
// business logic (icon/splash generation, dedup, package/platform
// resolution, version numbering) behind `/build-app-request` and
// `/build-status` — the same public endpoints the WebToNative web app
// itself uses. Re-implementing that against Mongo directly would mean
// duplicating (and likely breaking) rules that already exist there.
const API_BASE_URL = (
  process.env.WEBTONATIVE_API_BASE_URL || "https://api.webtonative.com"
).replace(/\/+$/, "");
const PORT = Number(process.env.PORT) || 8787;

type BuildStatus = "pending" | "building" | "success" | "failed";

// `AppBuildHistory.status` enum values (see src/mongo/schema/AppBuildHistory.ts
// in webtonative-apis) collapsed to the simplified states this MCP server exposes.
const STATUS_MAP: Record<string, BuildStatus> = {
  CAN_GENERATE: "pending",
  COPY_ASSETS: "building",
  GENERATE_SPLASH: "building",
  BUILDING_APP: "building",
  UPLOADING_APK: "building",
  IN_PROGRESS: "building",
  DONE: "success",
  FAILED: "failed",
  SYSTEM_ERROR: "failed",
  CANCELLED: "failed",
  ACTION_REQUIRED: "failed",
};

function normalizeUrl(input: string): string {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(candidate).toString();
}

function deriveAppName(websiteUrl: string): string {
  const host = new URL(websiteUrl).hostname.replace(/^www\./, "");
  const label = host.split(".")[0] || host;
  return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const PLATFORM_TO_PACKAGE_ID = {
  android: "ANDROID",
  ios: "IOS",
  both: "ANDROID_IOS",
} as const;
type Platform = keyof typeof PLATFORM_TO_PACKAGE_ID;

// `/build-status` is queried per single platform (android/ios) even for an
// ANDROID_IOS build — there is no combined value, so a "both" build needs
// two separate calls that get merged into one result below.
function aggregateStatus(statuses: BuildStatus[]): BuildStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((s) => s === "success")) return "success";
  if (statuses.some((s) => s === "building")) return "building";
  return "pending";
}

// `/build-app-request` tracks the pending-OTP state server-side in a
// Redis-backed session, keyed by the `w2n.connect.sid` cookie. This
// server has no browser to hold that cookie for the user across the
// generate_app -> verify_build_otp round trip, so it holds it here
// instead, keyed by the email the OTP was sent to. The session's own OTP
// TTL (10 minutes, see verifyOrSendBuildAppOtp in core.service.ts) is
// mirrored so an abandoned entry doesn't linger forever.
const OTP_SESSION_TTL_MS = 10 * 60 * 1000;
const pendingOtpSessions = new Map<
  string,
  { cookie: string; platform: Platform; expiresAt: number }
>();

function storeSessionCookie(
  emailId: string,
  cookie: string,
  platform: Platform,
) {
  pendingOtpSessions.set(emailId, {
    cookie,
    platform,
    expiresAt: Date.now() + OTP_SESSION_TTL_MS,
  });
}

function getSession(
  emailId: string,
): { cookie: string; platform: Platform } | null {
  const entry = pendingOtpSessions.get(emailId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingOtpSessions.delete(emailId);
    return null;
  }
  return entry;
}

function extractSessionCookie(res: Response): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookies.find((c) =>
    c.startsWith("w2n.connect.sid="),
  );
  return sessionCookie ? sessionCookie.split(";")[0] : null;
}

async function apiPost(path: string, body: unknown, cookie?: string) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
    ? { content: [{ type: "text" as const, text }], structuredContent }
    : { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Preview app shown to the end user for a running/finished build. ChatGPT
// renders this in a sandboxed iframe (the "Apps SDK" widget mechanism) once
// a tool's result carries the `openai/outputTemplate` _meta below and its
// structuredContent includes `buildId`.
// TEMPORARY: pointed at youtube.com to test that the widget/iframe mechanism
// itself works end-to-end; swap back to the real preview host below once
// confirmed. Note youtube.com sends X-Frame-Options and may refuse to load.
// const PREVIEW_BASE_URL = 'https://webtonativebeta.orufy.in/preview';
const PREVIEW_BASE_URL =
  "https://www.youtube.com/embed/GICP72POwLA?si=7RxZolnh82MZhdpA";
// CSP domain allowlists take bare origins only — a full URL with a path/query
// (like PREVIEW_BASE_URL above) is not a valid CSP source expression and can
// make the whole declaration get dropped, which blocks ALL nested iframes.
const PREVIEW_ORIGIN = new URL(PREVIEW_BASE_URL).origin;
const BUILD_PREVIEW_WIDGET_URI = "ui://widget/build-preview.html";

const BUILD_PREVIEW_WIDGET_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; }
      iframe { width: 100%; height: 100%; border: 0; display: block; }
      #empty { font: 14px system-ui, sans-serif; color: #666; padding: 16px; }
    </style>
  </head>
  <body>
    <div id="empty">Waiting for build details&hellip;</div>
    <script>
      function render() {
        const output = window.openai?.toolOutput;
        const buildId = output && output.buildId;
        if (!buildId) return;
        document.getElementById('empty').remove();
        const iframe = document.createElement('iframe');
        iframe.src = ${JSON.stringify(PREVIEW_BASE_URL)};
        iframe.allow = 'clipboard-write';
        document.body.appendChild(iframe);
      }
      window.addEventListener('openai:set_globals', render);
      render();
    </script>
  </body>
</html>`;

// _meta shared by every tool result that should open the build-preview
// iframe: points ChatGPT at the widget resource above and whitelists the
// preview host so it's allowed to load inside that sandboxed iframe.
const BUILD_PREVIEW_TOOL_META = {
  ui: {
    resourceUri: BUILD_PREVIEW_WIDGET_URI,
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [PREVIEW_ORIGIN],
    },
  },
  "openai/outputTemplate": BUILD_PREVIEW_WIDGET_URI,
  "openai/widgetCSP": {
    connect_domains: [],
    resource_domains: [],
    frame_domains: [PREVIEW_ORIGIN],
  },
};

function buildServer(): McpServer {
  const server = new McpServer({
    name: "webtonative-mcp-server",
    version: "1.0.0",
  });

  server.registerResource(
    "build-preview-widget",
    BUILD_PREVIEW_WIDGET_URI,
    { mimeType: "text/html+skybridge" },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/html+skybridge",
          text: BUILD_PREVIEW_WIDGET_HTML,
        },
      ],
    }),
  );

  server.registerTool(
    "generate_app",
    {
      title: "Generate a native app from a website",
      description:
        "Submit a website URL to start generating a native app (Android APK and/or iOS) for it. " +
        "Usually returns a buildId immediately — the build itself runs in the background " +
        "and is not finished yet when this returns. Call check_build_status with the " +
        "returned buildId (and the same platform) to track progress and get the final " +
        "download link. Occasionally (for a new or unusual-looking email) this instead sends " +
        'a one-time code to emailId and returns status "otp_required" — in that case, ask the ' +
        "user for the code from their email and call verify_build_otp with it.",
      inputSchema: {
        websiteUrl: z
          .string()
          .describe(
            "The website URL to convert into a native app, e.g. https://example.com",
          ),
        emailId: z
          .string()
          .email()
          .describe(
            "The user's email address, used to identify the build request.",
          ),
        appName: z
          .string()
          .optional()
          .describe(
            "Display name for the app. Defaults to a name derived from the domain.",
          ),
        platform: z
          .enum(["android", "ios", "both"])
          .optional()
          .default("both")
          .describe(
            "Which platform(s) to build for. Ask the user if they want Android, iOS, or both " +
              '— defaults to "both" if they have no preference.',
          ),
      },
      outputSchema: {
        status: z.enum(["queued", "otp_required"]),
        buildId: z.string().optional(),
        emailId: z.string().optional(),
        platform: z.enum(["android", "ios", "both"]).optional(),
      },
      _meta: BUILD_PREVIEW_TOOL_META,
    },
    async ({ websiteUrl, emailId, appName, platform }) => {
      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeUrl(websiteUrl);
      } catch {
        return errorResult(`"${websiteUrl}" is not a valid URL.`);
      }

      const finalAppName = appName?.trim() || deriveAppName(normalizedUrl);

      let response: { json: any; setCookie: string | null };
      try {
        response = await apiPost("/api/v1/build-app-request", {
          appName: finalAppName,
          emailId,
          packageId: PLATFORM_TO_PACKAGE_ID[platform],
          websiteUrl: normalizedUrl,
        });
      } catch (err: any) {
        return errorResult(
          `Failed to reach WebToNative API: ${err?.message || err}`,
        );
      }

      const { json: result, setCookie } = response;

      if (result?.isSuccess && result?.requestId) {
        // Email/site looked trustworthy enough that the OTP gate was
        // skipped — the build was created directly.
        return textResult(
          `Build started for ${normalizedUrl} (${platform}). Build ID: ${result.requestId}. ` +
            `Call check_build_status with this buildId and platform to check progress.`,
          { buildId: result.requestId, status: "queued", platform },
        );
      }

      if (result?.isSuccess && result?.otpSent) {
        if (!setCookie) {
          return errorResult(
            "OTP was sent but the session could not be tracked. Please retry.",
          );
        }
        storeSessionCookie(emailId, setCookie, platform);
        return textResult(
          `A one-time code was sent to ${emailId}. Ask the user for that code, then call ` +
            `verify_build_otp with emailId "${emailId}" and the code to start the build.`,
          { status: "otp_required", emailId, platform },
        );
      }

      return errorResult(
        `Could not start the build: ${result?.msg || result?.errorCode || "unknown error"}`,
      );
    },
  );

  server.registerTool(
    "verify_build_otp",
    {
      title: "Verify the OTP sent by generate_app",
      description:
        'Completes a build started by generate_app when it returned status "otp_required". ' +
        "Submit the one-time code the user received by email at that emailId to start the build.",
      inputSchema: {
        emailId: z
          .string()
          .email()
          .describe("The same emailId passed to generate_app."),
        otp: z
          .string()
          .describe("The one-time code the user received by email."),
      },
      outputSchema: {
        buildId: z.string(),
        status: z.literal("queued"),
        platform: z.enum(["android", "ios", "both"]),
      },
      _meta: BUILD_PREVIEW_TOOL_META,
    },
    async ({ emailId, otp }) => {
      const session = getSession(emailId);
      if (!session) {
        return errorResult(
          "No pending build request found for this email (it may have expired after 10 minutes). " +
            "Call generate_app again to restart.",
        );
      }
      const { cookie, platform } = session;

      let response: { json: any; setCookie: string | null };
      try {
        response = await apiPost(
          "/api/v1/build-app-request/verify-otp",
          { otp },
          cookie,
        );
      } catch (err: any) {
        return errorResult(
          `Failed to reach WebToNative API: ${err?.message || err}`,
        );
      }

      const { json: result, setCookie } = response;

      if (result?.isSuccess && result?.requestId) {
        pendingOtpSessions.delete(emailId);
        return textResult(
          `Build started (${platform}). Build ID: ${result.requestId}. ` +
            `Call check_build_status with this buildId and platform to check progress.`,
          { buildId: result.requestId, status: "queued", platform },
        );
      }

      if (
        result?.errorCode === "MAX_TRIES_EXCEEDED" ||
        result?.errorCode === "OTP_SESSION_EXPIRED"
      ) {
        pendingOtpSessions.delete(emailId);
      } else if (setCookie) {
        storeSessionCookie(emailId, setCookie, platform);
      }

      return errorResult(
        result?.errorCode === "INVALID_OTP"
          ? "That code is incorrect. Ask the user to double check it and try again."
          : `Could not verify the code: ${result?.errorCode || result?.msg || "unknown error"}`,
      );
    },
  );

  server.registerTool(
    "check_build_status",
    {
      title: "Check native app build status",
      description:
        "Check the status of an app build started with generate_app. Status progresses " +
        "through pending -> building -> success/failed. If the status is not yet " +
        '"success" or "failed", wait about 15-20 seconds and call this tool again with ' +
        'the same buildId. Once status is "success", the relevant downloadUrl is a direct ' +
        "link to the build artifact (APK for Android, IPA for iOS). Pass the same platform " +
        "that was used with generate_app / verify_build_otp for this buildId.",
      inputSchema: {
        buildId: z.string().describe("The buildId returned by generate_app"),
        platform: z
          .enum(["android", "ios", "both"])
          .optional()
          .default("android")
          .describe("Which platform(s) this buildId was generated for."),
      },
      outputSchema: {
        status: z.enum(["pending", "building", "success", "failed"]),
        downloadUrl: z.string().nullable(),
        android: z
          .object({
            status: z.enum(["pending", "building", "success", "failed"]),
            downloadUrl: z.string().nullable(),
          })
          .optional(),
        ios: z
          .object({
            status: z.enum(["pending", "building", "success", "failed"]),
            downloadUrl: z.string().nullable(),
          })
          .optional(),
      },
    },
    async ({ buildId, platform }) => {
      const platformsToQuery: Array<"android" | "ios"> =
        platform === "both" ? ["android", "ios"] : [platform];

      const fetched = await Promise.all(
        platformsToQuery.map(async (p) => {
          try {
            const result = await apiGet(
              `/api/v1/build-status?appId=${encodeURIComponent(buildId)}&platform=${p}`,
            );
            return { platform: p, result, error: null as string | null };
          } catch (err: any) {
            return {
              platform: p,
              result: null,
              error: err?.message || String(err),
            };
          }
        }),
      );

      const failedFetch = fetched.find((f) => f.error);
      if (failedFetch) {
        return errorResult(
          `Failed to reach WebToNative API: ${failedFetch.error}`,
        );
      }

      const unsuccessful = fetched.find((f) => !f.result?.isSuccess);
      if (unsuccessful) {
        return errorResult(
          `Could not fetch build status: ${unsuccessful.result?.err || unsuccessful.result?.message || "unknown error"}`,
        );
      }

      const perPlatform: Record<
        "android" | "ios",
        {
          status: BuildStatus;
          downloadUrl: string | null;
          failureReason?: string;
          rawStatus?: string;
        }
      > = {} as any;

      for (const { platform: p, result } of fetched) {
        const history = result.data;
        if (!history) {
          perPlatform[p] = { status: "pending", downloadUrl: null };
          continue;
        }
        const status = STATUS_MAP[history.status] || "pending";
        const downloadUrl =
          status === "success"
            ? p === "android"
              ? history.androidApkUrl || history.androidAabUrl || null
              : history.ipaUrl || null
            : null;
        perPlatform[p] = {
          status,
          downloadUrl,
          failureReason: history.failureReason,
          rawStatus: history.status,
        };
      }

      const overallStatus = aggregateStatus(
        platformsToQuery.map((p) => perPlatform[p].status),
      );
      const singlePlatform =
        platformsToQuery.length === 1 ? platformsToQuery[0] : null;

      const lines = platformsToQuery.map((p) => {
        const entry = perPlatform[p];
        const label = p === "android" ? "Android" : "iOS";
        if (entry.status === "success") {
          return entry.downloadUrl
            ? `${label}: build complete! Download: ${entry.downloadUrl}`
            : `${label}: build finished but no download URL was found yet.`;
        }
        if (entry.status === "failed") {
          return `${label}: build failed${entry.failureReason ? `: ${entry.failureReason}` : "."}`;
        }
        return `${label}: still in progress (status: ${entry.rawStatus}).`;
      });
      if (overallStatus === "building" || overallStatus === "pending") {
        lines.push("Check again in about 15-20 seconds.");
      }

      return textResult(lines.join("\n"), {
        status: overallStatus,
        downloadUrl: singlePlatform
          ? perPlatform[singlePlatform].downloadUrl
          : null,
        ...(perPlatform.android
          ? {
              android: {
                status: perPlatform.android.status,
                downloadUrl: perPlatform.android.downloadUrl,
              },
            }
          : {}),
        ...(perPlatform.ios
          ? {
              ios: {
                status: perPlatform.ios.status,
                downloadUrl: perPlatform.ios.downloadUrl,
              },
            }
          : {}),
      });
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for MCP requests.",
    },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`WebToNative MCP server listening on port ${PORT}`);
});
