/**
 * Vercel-compatible entry (design D3): thin wrapper delegating to the same
 * handler used by the local server. Release target only — never deployed in
 * v1.
 */

import type { ServerResponse, IncomingMessage } from "node:http";
import { createAnalysisHandler, type HandlerResult } from "./handler.js";
import { errorEnvelope, readBody, sendJson, SCHEMA, type ServerDeps } from "./server.js";

export interface VercelOptions {
  deps: ServerDeps;
  handlerFactory?: (deps: ServerDeps) => { handle: (raw: string) => Promise<HandlerResult> };
}

export function createVercelHandler(options: VercelOptions) {
  const handler = options.handlerFactory
    ? options.handlerFactory(options.deps)
    : createAnalysisHandler(options.deps);
  return async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST" || req.url !== "/analyze") {
        res.statusCode = req.method === "GET" && req.url === "/healthz" ? 200 : 404;
        res.end(req.method === "GET" && req.url === "/healthz" ? "ok" : "not found");
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
