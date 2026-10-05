/**
 * Vercel-compatible entry (design D3): thin wrapper delegating to the same
 * handler used by the local server. Routes: POST /analyze and POST /api/analyze
 * (analysis@1); GET /healthz and GET /api/healthz.
 *
 * Production guard (design D3): the shared (Redis) counter store is MANDATORY.
 * In-memory counters are per-instance and per-cold-start, so they would be
 * silently wrong across serverless instances — a deployment configured with
 * RYF_COUNTER_MODE=dev-memory (or missing/incomplete Redis config) fails
 * closed: every request gets HTTP 503 with the analysis@1 error envelope
 * (code "provider_unavailable"), and only the offending variable NAME is
 * logged. No client API key is required; the provider credential comes only
 * from server-side environment variables and is never logged or echoed.
 */

import type { ServerResponse, IncomingMessage } from "node:http";
import { BackendConfigError, DEFAULT_BACKEND_CONFIG, fromEnv } from "./config.js";
import { createAnalysisHandler, type HandlerResult } from "./handler.js";
import { errorEnvelope, readBody, sendJson, SCHEMA, type ServerDeps } from "./server.js";
import { SharedCounterStore } from "./counters/shared.js";
import { OpenCodeGoProvider } from "./providers/opencodego.js";

export interface VercelOptions {
  deps: ServerDeps;
  handlerFactory?: (deps: ServerDeps) => { handle: (raw: string) => Promise<HandlerResult> };
}

/** Strip the query string from a request URL. */
function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

const ANALYZE_PATHS = new Set(["/analyze", "/api/analyze"]);
const HEALTH_PATHS = new Set(["/healthz", "/api/healthz"]);

export function createVercelHandler(options: VercelOptions) {
  const handler = options.handlerFactory
    ? options.handlerFactory(options.deps)
    : createAnalysisHandler(options.deps);
  return async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = pathnameOf(req.url ?? "");
      if (req.method === "GET" && HEALTH_PATHS.has(path)) {
        res.statusCode = 200;
        res.end("ok");
        return;
      }
      if (req.method !== "POST" || !ANALYZE_PATHS.has(path)) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const raw = await readBody(req, options.deps.config.maxPayloadBytes);
      if (raw === null) {
        sendJson(res, 413, errorEnvelope("oversized_payload"));
        return;
      }
      const result = await handler.handle(raw);
      sendJson(
        res,
        result.outcome === "incomplete" && result.error.code === "oversized_payload" ? 413 : 200,
        result,
      );
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 200, {
          schema: SCHEMA,
          outcome: "incomplete",
          error: { code: "provider_unavailable" },
        });
      } else {
        res.destroy();
      }
      void error;
    }
  };
}

export { SCHEMA };

export interface VercelBoot {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  configError?: { variable: string; message: string };
}

/**
 * Production Vercel bootstrap (design D3): builds the injected dependencies
 * from environment variables, requiring the shared Redis counter store. Any
 * configuration failure yields a handler that fails closed with 503 on every
 * request — the endpoint is never served with local (in-memory) counters.
 */
export function createProductionVercelHandler(
  env: Record<string, string | undefined> = process.env,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let deps: ServerDeps | null = null;
  let configError: { variable: string; message: string } | null = null;
  try {
    const config = fromEnv(env);
    if (config.counterMode !== "redis" || config.redisUrl === undefined) {
      configError = {
        variable: "RYF_COUNTER_MODE",
        message:
          "production Vercel endpoint requires RYF_COUNTER_MODE=redis with RYF_REDIS_URL; " +
          "local-memory counters are not allowed in a multi-instance serverless deployment",
      };
    } else {
      deps = {
        store: new SharedCounterStore({
          url: config.redisUrl,
          keyPrefix: config.redisKeyPrefix,
          quotaPerDay: DEFAULT_BACKEND_CONFIG.quotaPerDay,
          concurrencyLimit: DEFAULT_BACKEND_CONFIG.concurrencyLimit,
        }),
        provider: new OpenCodeGoProvider({
          endpoint: config.providerEndpoint,
          model: config.providerModel,
          credentialHandle: config.credentialHandle,
        }),
        config: { ...DEFAULT_BACKEND_CONFIG },
      };
    }
  } catch (error) {
    if (error instanceof BackendConfigError) {
      configError = { variable: error.variable, message: error.message };
    } else {
      throw error;
    }
  }

  if (configError !== null && configError !== undefined) {
    const ce = configError;
    return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      process.stderr.write(`vercel endpoint configuration error: ${ce.variable}: ${ce.message}\n`);
      sendJson(res, 503, {
        schema: SCHEMA,
        outcome: "incomplete",
        error: { code: "provider_unavailable" },
      });
    };
  }
  // deps is non-null whenever configError is null.
  return createVercelHandler({ deps: deps as ServerDeps, handlerFactory: null as never });
}
