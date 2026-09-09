/**
 * Operator bootstrap (design D8, Unit C task 3.2/3.3): reads env, parses it
 * via `fromEnv`, constructs the injected dependencies (counter store per the
 * explicit counter mode, OpenCodeGoProvider with the server-side credential
 * handle), and starts the HTTP server with `createBackendServer(...).listen()`.
 *
 * - Default bind is secure loopback (127.0.0.1); binding a non-loopback host
 *   requires an explicit RYF_BIND_HOST (a loud warning is emitted).
 * - PORT is honored (default DEFAULT_OPERATOR_PORT).
 * - A missing required configuration (counter mode, provider endpoint, model,
 *   credential) exits non-zero with a named-variable diagnostic on stderr and
 *   never opens a listening socket — distinct from runtime connection failures.
 * - The credential VALUE, the provider URL, and any Redis URL are never echoed
 *   in startup diagnostics or logs; only the offending variable NAME is named.
 * - The server OWNS the counter store's backing connection (Redis); `close()`
 *   tears the server and the store down together so no connection leaks.
 *
 * Run with `node dist/backend/main.js` (no package.json bin entry is added —
 * package metadata is owned by another unit).
 */
import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { DEFAULT_BACKEND_CONFIG, fromEnv, type OperatorConfig } from "./config.js";
import { InMemoryCounterStore } from "./counters/in-memory.js";
import { SharedCounterStore } from "./counters/shared.js";
import { OpenCodeGoProvider } from "./providers/opencodego.js";
import { createBackendServer } from "./server.js";
import type { AnalysisProvider, CounterStore } from "./types.js";

export interface BootstrapDeps {
  store: CounterStore;
  provider: AnalysisProvider;
}

/** A running backend + its owned store, with a single teardown path. */
export interface BootstrapHandle {
  server: Server;
  store: CounterStore;
  /** Close the server AND any store-owned connection (idempotent). */
  close(): Promise<void>;
}

/** Construct the injected dependencies from a parsed operator config. */
export function buildDeps(config: OperatorConfig): BootstrapDeps {
  const store: CounterStore =
    config.counterMode === "redis"
      ? new SharedCounterStore({
          url: config.redisUrl ?? "",
          keyPrefix: config.redisKeyPrefix,
          quotaPerDay: DEFAULT_BACKEND_CONFIG.quotaPerDay,
          concurrencyLimit: DEFAULT_BACKEND_CONFIG.concurrencyLimit,
        })
      : new InMemoryCounterStore({
          quotaPerDay: DEFAULT_BACKEND_CONFIG.quotaPerDay,
          concurrencyLimit: DEFAULT_BACKEND_CONFIG.concurrencyLimit,
        });
  const provider: AnalysisProvider = new OpenCodeGoProvider({
    endpoint: config.providerEndpoint,
    model: config.providerModel,
    credentialHandle: config.credentialHandle,
  });
  return { store, provider };
}

/**
 * Start the HTTP server on the configured loopback host + port. Resolves once
 * the server is listening with a handle that tears the server and the owned
 * store down together.
 */
export function startServer(config: OperatorConfig): Promise<BootstrapHandle> {
  const { store, provider } = buildDeps(config);
  const server = createBackendServer({
    handlerFactory: null,
    deps: { store, provider, config: { ...DEFAULT_BACKEND_CONFIG } },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    const storeWithClose = store as { close?: () => Promise<void> };
    await storeWithClose.close?.();
  };
  return new Promise<BootstrapHandle>((resolveListen, reject) => {
    const onError = (error: unknown): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen({ server, store, close });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.bindHost);
  });
}

/**
 * Operator entry: parse config, warn on non-loopback bind, start the server.
 * Returns 1 (non-zero) with a named-variable stderr diagnostic when required
 * configuration is missing/invalid — before any socket is opened.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  let config: OperatorConfig;
  try {
    config = fromEnv(env);
  } catch (error) {
    if (error instanceof Error && error.name === "BackendConfigError") {
      process.stderr.write(`configuration error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (config.bindHost !== "127.0.0.1" && config.bindHost !== "localhost") {
    process.stderr.write(
      `warning: binding to non-loopback host ${config.bindHost} - expose only on a trusted network\n`,
    );
  }

  const handle = await startServer(config);
  process.stdout.write(
    `rate-your-flow backend listening on http://${config.bindHost}:${config.port}\n`,
  );
  // Graceful shutdown: close the server and the owned store so no connection leaks.
  const shutdown = (signal: string): void => {
    void handle.close().finally(() => {
      process.stdout.write(`rate-your-flow backend shut down (${signal})\n`);
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return 0;
}

// Direct-run guard that works through an installed symlink: compare the invoked
// path's realpath with this module's realpath (same pattern as src/cli/bin.ts).
const isDirectRun = ((): boolean => {
  try {
    const invoked = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : undefined;
    if (invoked === undefined) return false;
    return invoked === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main(process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `rate-your-flow backend failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
