import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeGoProvider } from "../../src/backend/providers/opencodego.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";
import { DIMENSIONS } from "../../src/shared/contracts/index.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

/** Recording stub: captures per-request User-Agent + x-opencode-session. */
let server: Server;
let baseUrl = "";
let userAgents: string[] = [];
let sessions: string[] = [];
let requestCount = 0;

function validCompletion(): string {
  const dimensions = DIMENSIONS.map((dimension, index) => ({
    dimension,
    score: 55 + index,
    evaluable: true,
    evidence: [{ sessionId: "s1", line: 1 }],
    notes: `note ${dimension}`,
  }));
  return JSON.stringify({
    id: "chatcmpl-mock",
    choices: [{ message: { role: "assistant", content: JSON.stringify(dimensions) } }],
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    userAgents.push(String(req.headers["user-agent"] ?? ""));
    sessions.push(String(req.headers["x-opencode-session"] ?? ""));
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      // First request of a bounded-retry exchange returns an invalid body; the
      // adapter retries ONCE and the second request is valid.
      if (requestCount === 1) {
        res.end('{"choices":[{"message":{"content":"NOT_JSON"}}]}');
      } else {
        res.end(validCompletion());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  userAgents = [];
  sessions = [];
  requestCount = 0;
});

function makeProvider(credentialHandle = "dummy-handle"): OpenCodeGoProvider {
  return new OpenCodeGoProvider({
    endpoint: baseUrl,
    model: "glm-5.3-flash",
    credentialHandle,
  });
}

describe("OpenCodeGoProvider client identity headers (task 3.4)", () => {
  it("sends the 0.1.7 product User-Agent", async () => {
    await makeProvider().analyze(DIGEST, { timeoutMs: 2_000, credentialHandle: "dummy-handle" });
    expect(userAgents[0]).toBe("rate-your-flow/0.1.7");
  });

  it("sends a non-empty x-opencode-session header", async () => {
    await makeProvider().analyze(DIGEST, { timeoutMs: 2_000, credentialHandle: "dummy-handle" });
    expect(sessions[0]).toBeTruthy();
    expect(sessions[0]!.length).toBeGreaterThan(0);
  });

  it("reuses the SAME x-opencode-session across the bounded retry of one exchange", async () => {
    await makeProvider().analyze(DIGEST, { timeoutMs: 2_000, credentialHandle: "dummy-handle" });
    // Request count of 2 => the first was invalid (NOT_JSON) and the adapter retried once.
    expect(requestCount).toBe(2);
    expect(sessions[0]).toBeTruthy();
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[0]).toEqual(sessions[1]);
  });

  it("does not leak the credential handle into the identity headers", async () => {
    await makeProvider("never-on-wire-secret").analyze(DIGEST, {
      timeoutMs: 2_000,
      credentialHandle: "never-on-wire-secret",
    });
    for (const ua of userAgents) expect(ua).not.toContain("never-on-wire-secret");
    for (const session of sessions) expect(session).not.toContain("never-on-wire-secret");
  });
});
