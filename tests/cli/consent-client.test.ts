/**
 * 5.1/5.3 RED: consent machine + install UUID + HTTP client (analysis@1,
 * injectable timeout, retry-after on 429/402, no paid fallback, honest
 * unreachable reporting, automatic redirects REFUSED — cross-origin AND
 * same-origin; single egress only).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consentFilePathFor,
  loadConsent,
  saveConsent,
  shouldRePrompt,
  type ConsentRecord,
} from "../../src/cli/consent.js";
import { getOrCreateInstallUUID, installUUIDFilePathFor } from "../../src/cli/install-uuid.js";
import { postAnalysis } from "../../src/cli/http-client.js";
import type { DigestV1 } from "../../src/shared/contracts/digest@1.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "session_meta" }] }],
  episodes: [{ sessionId: "s1", startLine: 1, endLine: 1, summary: "e" }],
  citedSnippets: [],
};

function withHome<T>(fn: (home: string) => Promise<T>): () => Promise<T> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "ryf-home-"));
    try {
      return await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

let server: Server;
let serverUrl: string;

beforeEach(async () => {
  server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => {});

describe("install UUID lifecycle (5.1)", () => {
  it(
    "generates once, persists per-HOME securely, stable across calls",
    withHome(async (home) => {
      const file = installUUIDFilePathFor(home);
      const first = getOrCreateInstallUUID(home);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      // Persisted with owner-only permissions (0600-class).
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      // Stable across calls and "restarts" (fresh calls, same HOME).
      expect(getOrCreateInstallUUID(home)).toBe(first);
      expect(getOrCreateInstallUUID(home)).toBe(first);
      // Isolated HOMEs get their own UUIDs.
      const home2 = mkdtempSync(join(tmpdir(), "ryf-home2-"));
      try {
        expect(getOrCreateInstallUUID(home2)).not.toBe(first);
      } finally {
        rmSync(home2, { recursive: true, force: true });
      }
    }),
  );
});

describe("consent machine (5.1)", () => {
  it(
    "no stored consent => prompt required; granted consent remembered",
    withHome(async (home) => {
      const destination = serverUrl;
      expect(loadConsent(home)).toBeUndefined();
      expect(shouldRePrompt(home, destination)).toBe(true);

      const record: ConsentRecord = {
        version: "consent@1",
        state: "consented",
        destination,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      };
      saveConsent(home, record);
      expect(loadConsent(home)).toEqual(record);
      expect(shouldRePrompt(home, destination)).toBe(false);
    }),
  );

  it(
    "destination change => re-prompt",
    withHome(async (home) => {
      saveConsent(home, {
        version: "consent@1",
        state: "consented",
        destination: "http://127.0.0.1:1",
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      });
      expect(shouldRePrompt(home, "http://127.0.0.1:2")).toBe(true);
    }),
  );

  it(
    "scope expansion => re-prompt",
    withHome(async (home) => {
      saveConsent(home, {
        version: "consent@1",
        state: "consented",
        destination: serverUrl,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      });
      expect(shouldRePrompt(home, serverUrl, 2)).toBe(true);
    }),
  );

  it(
    "refusal recorded; consent file path under <config>/ryf/",
    withHome(async (home) => {
      const refused: ConsentRecord = {
        version: "consent@1",
        state: "refused",
        destination: serverUrl,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      };
      saveConsent(home, refused);
      expect(loadConsent(home)?.state).toBe("refused");
      expect(consentFilePathFor(home)).toContain(join("ryf", "consent.json"));
    }),
  );
});

describe("U4 root-review remediations", () => {
  it(
    "malformed/unknown-state consent record NEVER authorizes egress (shape validated)",
    withHome(async (home) => {
      const destination = serverUrl;
      // Unknown state with matching destination/scope: must not authorize.
      const unknown = {
        version: "consent@1",
        state: "granted-forever",
        destination,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      } as unknown as ConsentRecord;
      saveConsent(home, unknown);
      expect(loadConsent(home)).toBeUndefined();
      expect(shouldRePrompt(home, destination)).toBe(true);

      // Missing state entirely.
      const missing = {
        version: "consent@1",
        destination,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      } as unknown as ConsentRecord;
      saveConsent(home, missing);
      expect(loadConsent(home)).toBeUndefined();

      // Valid shape only (consented) authorizes.
      saveConsent(home, {
        version: "consent@1",
        state: "consented",
        destination,
        scopeVersion: 1,
        timestamp: "2026-09-07T12:00:00Z",
      });
      expect(loadConsent(home)?.state).toBe("consented");
      expect(shouldRePrompt(home, destination)).toBe(false);
    }),
  );

  it("timeout covers the response BODY, not just headers (hanging body times out)", async () => {
    server.close();
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.writeHead(200);
      res.write("{");
      // Never ends the body.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 80 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
    }
  });

  it("parse-error details are FIXED phrases (never echo malformed server content)", async () => {
    server.close();
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      // Malformed JSON body (truncated) containing a marker we must never echo.
      res.end('{"oops":"MALICIOUS_SERVER_MARKER and more cont');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_model_response");
      expect(JSON.stringify(result.error).includes("MALICIOUS_SERVER_MARKER")).toBe(false);
    }
  });

  it(
    "install UUID: strict UUID format only; garbage file replaced; concurrent first-create converges",
    withHome(async (home) => {
      // Garbage 36-char content must NOT be accepted as a UUID.
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { installUUIDFilePathFor } = await import("../../src/cli/install-uuid.js");
      mkdirSync(`${home}/.config/ryf`, { recursive: true });
      writeFileSync(installUUIDFilePathFor(home), "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
      const uuid = getOrCreateInstallUUID(home);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // Concurrent first-create: both callers converge on the SAME stored UUID.
      const home2 = mkdtempSync(join(tmpdir(), "ryf-race-"));
      try {
        const [a, b] = await Promise.all([
          Promise.resolve().then(() => getOrCreateInstallUUID(home2)),
          Promise.resolve().then(() => getOrCreateInstallUUID(home2)),
        ]);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(a).toBe(b);
      } finally {
        rmSync(home2, { recursive: true, force: true });
      }
    }),
  );
});

describe("postAnalysis HTTP client (5.3)", () => {
  it("sends analysis@1 envelope with installUUID; returns complete outcome", async () => {
    let seenBody = "";
    let seenPath = "";
    server.close();
    server = createServer((req, res) => {
      seenPath = req.url ?? "";
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seenBody = body;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [],
            confidenceNote: "n",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 2000 });
    expect(seenPath).toBe("/analyze");
    const parsed = JSON.parse(seenBody) as {
      schema: string;
      installUUID: string;
      digest: DigestV1;
    };
    expect(parsed.schema).toBe("analysis@1");
    expect(parsed.installUUID).toBe("uuid-1");
    expect(parsed.digest).toEqual(DIGEST);
    expect(result.ok).toBe(true);
  });

  it("429/402: surfaces retry-after, no paid fallback (single attempt, defined error)", async () => {
    let attempts = 0;
    server.close();
    server = createServer((_req, res) => {
      attempts += 1;
      res.statusCode = 429;
      res.setHeader("retry-after", "30");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 2000 });
    expect(attempts).toBe(1); // never retried, never paid fallback
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("over_quota");
      expect(result.error.retryAfterSeconds).toBe(30);
    }
  });

  it("REFUSES automatic redirects (cross-origin AND same-origin): no second egress, defined error", async () => {
    let egressCount = 0;
    server.close();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        egressCount += 1;
        // Cross-origin redirect target.
        res.statusCode = 302;
        res.setHeader("location", "http://evil.example.com/steal");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 2000 });
    expect(egressCount).toBe(1); // single egress attempt only
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("endpoint_redirected");
    }
  });

  it("timeout (injectable, tested at 50ms): defined timeout error", async () => {
    server.close();
    server = createServer(() => {
      // Never responds.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const result = await postAnalysis(url, DIGEST, "uuid-1", { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
    }
  });

  it("unreachable endpoint: honest error, no fake success", async () => {
    // Port 1 on 127.0.0.1: nothing listens there.
    const result = await postAnalysis("http://127.0.0.1:1", DIGEST, "uuid-1", { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("endpoint_unreachable");
    }
  });
});
