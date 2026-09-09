/**
 * Backend HTTP service (design D3): plain Node HTTP adapter, runnable locally
 * (Portless-compatible dev server) and thin-wrapped for Vercel (never deployed
 * in v1). Routes: POST /analyze (analysis@1), GET /healthz. Body bytes are
 * capped during accumulation (oversized_payload before the provider); the
 * handler owns contract validation, counters, and provider dispatch.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEFAULT_BACKEND_CONFIG, type BackendConfig } from "./config.js";
import { createAnalysisHandler, type HandlerResult } from "./handler.js";
import type { AnalysisProvider, CounterStore } from "./types.js";
import type { AnalyzeError, AnalysisErrorCode } from "../shared/contracts/index.js";

export interface ServerDeps {
  store: CounterStore;
  provider: AnalysisProvider;
  config: BackendConfig;
  now?: () => number;
}

export interface ServerOptions {
  deps: ServerDeps;
  /** Optional prebuilt handler (tests inject doubles); built from deps when absent. */
  handlerFactory:
    ((deps: ServerDeps) => { handle: (raw: string) => Promise<HandlerResult> }) | null;
}

const SCHEMA = "analysis@1";
export { SCHEMA };

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: AnalyzeError | HandlerResult | string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export function errorEnvelope(
  code: Extract<AnalysisErrorCode, "oversized_payload" | "invalid_model_response">,
): AnalyzeError {
  return { schema: SCHEMA, outcome: "incomplete", error: { code } };
}

export function readBody(
  req: IncomingMessage,
  maxBytes: number,
  onOversize?: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let oversized = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (oversized) return; // drain: let the client finish, respond already sent
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        onOversize?.(); // respond 413 now; connection closes after end
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(oversized ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  handle: (raw: string) => Promise<HandlerResult>,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/analyze") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const maxBytes = deps.config.maxPayloadBytes;
  const raw = await readBody(req, maxBytes, () => {
    // 413 while the client is still uploading; close after responding.
    res.writeHead(413, {
      "content-type": "application/json",
      connection: "close",
    });
    res.end(JSON.stringify(errorEnvelope("oversized_payload")));
  });
  if (raw === null) {
    return;
  }
  // Handler re-checks byte size pre-provider (defense in depth) and owns the
  // contract; a handler-level schema rejection is surfaced as 200-envelope
  // incomplete (the CLI inspects outcome, not transport status).
  const result = await handle(raw);
  if (result.outcome === "incomplete" && result.error.code === "oversized_payload") {
    sendJson(res, 413, result);
    return;
  }
  sendJson(res, 200, result);
}

export function createBackendServer(options: ServerOptions): Server {
  const handler = options.handlerFactory
    ? options.handlerFactory(options.deps)
    : createAnalysisHandler(options.deps);
  return createServer((req, res) => {
    void route(req, res, options.deps, handler.handle).catch((error: unknown) => {
      // Safe errors: never leak internals; degrade as provider_unavailable.
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
    });
  });
}

export { DEFAULT_BACKEND_CONFIG, type IncomingMessage, type ServerResponse };
