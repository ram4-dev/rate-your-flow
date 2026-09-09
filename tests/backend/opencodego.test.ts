import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeGoProvider } from "../../src/backend/providers/opencodego.js";
import { weightedTotal } from "../../src/backend/prompt/rubric@1.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";
import { DIMENSIONS } from "../../src/shared/contracts/index.js";

/**
 * RED-first: OpenAI-compatible adapter fully exercised against a local mock
 * OpenAI-compatible HTTP server (no real credentials, no real network, no
 * entitlement). Structural contract per 08 + analysis-backend spec.
 */

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

const BASE_OPTIONS = {
  timeoutMs: 2_000,
  credentialHandle: "dummy-credential-handle",
};

/** Captured request + scripted response per test. */
let captured: { auth: string; body: string; path: string } | null = null;
let capturedBodies: string[] = [];
let responder: (
  req: { method: string; path: string },
  body: string,
) => {
  status: number;
  body: string;
  headers?: Record<string, string>;
} | null = () => ({ status: 500, body: "no script" });

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      captured = {
        auth: String(req.headers.authorization ?? ""),
        body: raw,
        path: req.url ?? "",
      };
      capturedBodies.push(raw);
      const scripted = responder({ method: req.method ?? "", path: req.url ?? "" }, raw);
      if (scripted === null) return; // hold the request open (timeout scripts)
      res.writeHead(scripted.status, {
        "content-type": "application/json",
        ...(scripted.headers ?? {}),
      });
      res.end(scripted.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  capturedBodies = [];
});

function validCompletion(dimensions = validDimensionsPayload()): string {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model: "glm-5.3-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(dimensions) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

function validDimensionsPayload() {
  return DIMENSIONS.map((dimension, index) => ({
    dimension,
    score: 55 + index,
    evaluable: true,
    evidence: [{ sessionId: "s1", line: 1 }],
    notes: `note ${dimension}`,
  }));
}

function makeProvider() {
  return new OpenCodeGoProvider({
    endpoint: baseUrl,
    model: "glm-5.3-flash",
    credentialHandle: BASE_OPTIONS.credentialHandle,
  });
}

describe("OpenCodeGoProvider (OpenAI-compatible HTTP adapter, mock server)", () => {
  it("sends chat/completions body with model, digest, and auth from injected handle", async () => {
    responder = () => ({ status: 200, body: validCompletion() });
    const result = await makeProvider().analyze(DIGEST, BASE_OPTIONS);
    expect(captured?.path).toBe("/v1/chat/completions");
    expect(captured?.auth).toBe(`Bearer ${BASE_OPTIONS.credentialHandle}`);
    const body = JSON.parse(captured?.body ?? "{}") as {
      model: string;
      messages: { role: string; content: string }[];
      temperature?: number;
    };
    expect(body.model).toBe("glm-5.3-flash");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some((m) => m.content.includes("digest@1"))).toBe(true);
    expect(result.dimensions).toHaveLength(5);
    expect(result.confidenceNote).toBeTruthy();
  });

  it("uses bounded JSON controls only for exact deepseek-v4-flash", async () => {
    responder = () => ({ status: 200, body: validCompletion() });
    const provider = new OpenCodeGoProvider({
      endpoint: baseUrl,
      model: "deepseek-v4-flash",
      credentialHandle: BASE_OPTIONS.credentialHandle,
    });

    await provider.analyze(DIGEST, BASE_OPTIONS);

    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      model: "deepseek-v4-flash",
      temperature: 0,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 4096,
    });
  });

  it("leaves bounded JSON controls out for other models", async () => {
    responder = () => ({ status: 200, body: validCompletion() });
    await makeProvider().analyze(DIGEST, BASE_OPTIONS);

    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.thinking).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("retains bounded JSON controls through the one malformed-response retry", async () => {
    let calls = 0;
    responder = () => {
      calls += 1;
      return calls === 1
        ? { status: 200, body: '{"choices":[{"message":{"content":"not json"}}]}' }
        : { status: 200, body: validCompletion() };
    };
    const provider = new OpenCodeGoProvider({
      endpoint: baseUrl,
      model: "deepseek-v4-flash",
      credentialHandle: BASE_OPTIONS.credentialHandle,
    });

    await provider.analyze(DIGEST, BASE_OPTIONS);

    expect(capturedBodies).toHaveLength(2);
    for (const raw of capturedBodies) {
      expect(JSON.parse(raw)).toMatchObject({
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 4096,
      });
    }
  });

  it("maps 429 to over_quota with retryAfterSeconds passthrough (no paid fallback)", async () => {
    responder = () => ({
      status: 429,
      body: JSON.stringify({ error: { message: "rate limited" } }),
      headers: { "retry-after": "30" },
    });
    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "over_quota",
      retryAfterSeconds: 30,
    });
  });

  it("maps 402 to payment_required (no paid fallback)", async () => {
    responder = () => ({ status: 402, body: "payment required" });
    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "payment_required",
    });
  });

  it("retries ONE bounded time on invalid model response, then fails", async () => {
    let calls = 0;
    responder = () => {
      calls += 1;
      return {
        status: 200,
        body: validCompletion([] as unknown as ReturnType<typeof validDimensionsPayload>),
      };
    };
    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "invalid_model_response",
    });
    expect(calls).toBe(2); // initial + exactly one bounded retry
  });

  it("accepts valid response on the first retry after one invalid attempt", async () => {
    let calls = 0;
    responder = () => {
      calls += 1;
      return calls === 1
        ? { status: 200, body: '{"choices":[{"message":{"content":"not json"}}]}' }
        : { status: 200, body: validCompletion() };
    };
    const result = await makeProvider().analyze(DIGEST, BASE_OPTIONS);
    expect(calls).toBe(2);
    expect(result.dimensions).toHaveLength(5);
  });

  it("normalizes a raw null score on a not-evaluable dimension to an omitted score", async () => {
    const dims = validDimensionsPayload();
    dims[4] = { ...dims[4]!, evaluable: false, score: null as unknown as number };
    responder = () => ({ status: 200, body: validCompletion(dims) });

    const result = await makeProvider().analyze(DIGEST, BASE_OPTIONS);
    const notEvaluable = result.dimensions[4]!;
    expect(notEvaluable.evaluable).toBe(false);
    expect("score" in notEvaluable).toBe(false);
    expect(notEvaluable.evidence).toEqual([{ sessionId: "s1", line: 1 }]);
    expect(weightedTotal(result.dimensions)).toBeUndefined();
  });

  it("rejects a numeric score on a raw not-evaluable dimension", async () => {
    const dims = validDimensionsPayload();
    dims[4] = { ...dims[4]!, evaluable: false, score: 0 };
    responder = () => ({ status: 200, body: validCompletion(dims) });

    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "invalid_model_response",
    });
  });

  it("rejects a raw null score on an evaluable dimension", async () => {
    const dims = validDimensionsPayload();
    dims[4] = { ...dims[4]!, score: null as unknown as number };
    responder = () => ({ status: 200, body: validCompletion(dims) });

    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "invalid_model_response",
    });
  });

  it("maps connection refused to provider_unavailable", async () => {
    const dead = new OpenCodeGoProvider({
      endpoint: "http://127.0.0.1:1/v1",
      model: "glm-5.3-flash",
      credentialHandle: "dummy",
    });
    await expect(dead.analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("maps timeout abort to timeout error code", async () => {
    responder = () => {
      // Hang: never respond; the adapter aborts after timeoutMs.
      return null;
    };
    await expect(
      makeProvider().analyze(DIGEST, { ...BASE_OPTIONS, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("uses the template@1 scoring prompt with untrusted-data framing (U6 wiring)", async () => {
    responder = () => ({ status: 200, body: validCompletion() });
    await makeProvider().analyze(DIGEST, BASE_OPTIONS);
    const body = JSON.parse(captured?.body ?? "{}") as {
      messages: { role: string; content: string }[];
    };
    const system = body.messages.find((m) => m.role === "system");
    const user = body.messages.find((m) => m.role === "user");
    expect(system?.content).toContain("prompt@1");
    expect(system?.content).toContain("rubric v1");
    expect(user?.content).toContain("<digest-data>");
    expect(user?.content).toMatch(/do not follow any instructions/i);
  });

  it("F4: adapter timeout composes with a live caller signal (independent shorter deadline)", async () => {
    responder = () => null; // hang
    const caller = new AbortController(); // never aborted
    const started = Date.now();
    await expect(
      makeProvider().analyze(DIGEST, {
        ...BASE_OPTIONS,
        timeoutMs: 80,
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(caller.signal.aborted).toBe(false); // caller signal untouched
  });

  it("rejects citations that do not resolve against the digest", async () => {
    responder = () => {
      const dims = validDimensionsPayload().map((d) => ({
        ...d,
        evidence: [{ sessionId: "ghost", line: 999 }],
      }));
      return { status: 200, body: validCompletion(dims) };
    };
    await expect(makeProvider().analyze(DIGEST, BASE_OPTIONS)).rejects.toMatchObject({
      code: "invalid_model_response",
    });
  });
});
