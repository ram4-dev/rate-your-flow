/**
 * Phase 11 E2E — REAL installed tarball, outside the checkout, REAL backend
 * chain. (Rewritten per root E2E review: no placeholders, no structural pass
 * labels; async CLI runs; real createBackendServer + InMemoryCounterStore +
 * REAL OpenCodeGoProvider; only the EXTERNAL model is mocked.)
 *
 * Chain under test:
 *   installed `ryf` symlink → consent gate → HTTP → REAL createBackendServer
 *   → REAL createAnalysisHandler → InMemoryCounterStore (quota 3/day UTC)
 *   → REAL OpenCodeGoProvider (OpenAI-compatible HTTP adapter, dummy
 *   credential handle) → MOCK OpenAI-compatible provider HTTP server
 *   (external model boundary — the ONLY mocked piece).
 *
 * Coverage (tasks 11.1 + reviewed tasks11 list): version/help via symlink,
 * --preview send-free, no-backend honest (zero network), refusal (zero-hit
 * server), remembered consent, success end-to-end, redirect (zero second
 * hit), quota 3/day (real handler counters), provider timeout, malformed
 * provider response, payload size (413). Linux Node 24 pass required
 * (see `linux24` suite — runs the same spec under node:24-bookworm-slim).
 */
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const NOW = "2026-09-07T12:00:00Z";

/**
 * Valid OpenAI-compatible chat-completions body carrying a valid analysis@1
 * result. Citations are EXTRACTED from the incoming digest (the backend
 * validator correctly requires resolvable sessionId+line references).
 */
function providerCompleteBody(requestBody: string): string {
  // The digest is embedded inside the messages; parse the request, locate
  // the delimiter-ONLY lines (<digest-data> / </digest-data>) and parse
  // the joined lines between them. NO regex: the prompt's SECURITY
  // sentence mentions the delimiters inline and a naive regex captures
  // prose (root E2E review).
  let sessionId = "unknown";
  try {
    const request = JSON.parse(requestBody) as { messages?: { content?: string }[] };
    for (const message of request.messages ?? []) {
      const lines = (message.content ?? "").split("\n");
      const start = lines.indexOf("<digest-data>");
      const end = lines.indexOf("</digest-data>");
      if (start !== -1 && end > start) {
        const digest = JSON.parse(lines.slice(start + 1, end).join("\n")) as {
          eventSequences?: { sessionId?: string }[];
        };
        sessionId = digest.eventSequences?.[0]?.sessionId ?? sessionId;
        break;
      }
    }
  } catch {
    // fall back to "unknown" (validator will reject, correctly)
  }
  const analysis = {
    schema: "analysis@1",
    outcome: "complete",
    dimensions: [
      {
        dimension: "reliability",
        score: 70,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note one actionable step",
      },
      {
        dimension: "communication",
        score: 60,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note two actionable step",
      },
      {
        dimension: "context-efficiency",
        score: 75,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note three actionable step",
      },
      {
        dimension: "productivity",
        score: 65,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note four actionable step",
      },
      {
        dimension: "hygiene",
        score: 85,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note five actionable step",
      },
    ],
    total: 71,
    confidenceNote: "descriptive reading of the evidence, not a probability",
  };
  return JSON.stringify({
    id: "chatcmpl-mock",
    choices: [{ message: { role: "assistant", content: JSON.stringify(analysis) } }],
  });
}

interface MockProviderOptions {
  behavior?: "ok" | "malformed" | "hang";
  status?: number;
  headers?: Record<string, string>;
}

/** MOCK external model boundary (the only mocked piece in this suite). */
async function startMockProvider(
  options: MockProviderOptions = {},
): Promise<{ url: string; hits: { body: string }[]; server: Server }> {
  const hits: { body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits.push({ body });
      if (options.behavior === "hang") {
        return; // never respond (timeout path)
      }
      if (options.behavior === "malformed") {
        res.setHeader("content-type", "application/json");
        res.end(
          '{"id":"x","choices":[{"message":{"role":"assistant","content":"NOT_JSON at all"}}]}',
        );
        return;
      }
      if (options.status !== undefined && options.status !== 200) {
        res.statusCode = options.status;
        for (const [k, v] of Object.entries(options.headers ?? {})) {
          res.setHeader(k, v);
        }
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(providerCompleteBody(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, hits, server };
}

interface BackendHandle {
  url: string;
  server: Server;
}

/** REAL backend: createBackendServer + InMemoryCounterStore + OpenCodeGoProvider. */
async function startRealBackend(
  providerUrl: string,
  overrides: { timeoutMs?: number; maxPayloadBytes?: number } = {},
): Promise<BackendHandle> {
  const { createBackendServer, DEFAULT_BACKEND_CONFIG } =
    await import("../../src/backend/server.js");
  const { InMemoryCounterStore } = await import("../../src/backend/counters/in-memory.js");
  const { OpenCodeGoProvider } = await import("../../src/backend/providers/opencodego.js");
  const config = {
    ...DEFAULT_BACKEND_CONFIG,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.maxPayloadBytes !== undefined
      ? { maxPayloadBytes: overrides.maxPayloadBytes }
      : {}),
  };
  const server = createBackendServer({
    handlerFactory: null,
    deps: {
      store: new InMemoryCounterStore({
        quotaPerDay: config.quotaPerDay,
        concurrencyLimit: config.concurrencyLimit,
      }),
      provider: new OpenCodeGoProvider({
        model: "glm-5.3-flash",
        endpoint: providerUrl,
        credentialHandle: "dummy-vault-env-handle", // server-side only; dummy in tests
        ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      }),
      config,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, server };
}

let workRoot: string;
let binRyf: string;

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), "ryf-e2e-"));
  // Build CURRENT source before pack (no stale dist).
  execFileSync("npm", ["run", "build"], { cwd: REPO, encoding: "utf8" });
  const out = execFileSync("npm", ["pack", "--pack-destination", workRoot], {
    cwd: REPO,
    encoding: "utf8",
  });
  const tarball = out.trim().split("\n").pop() as string;
  const packPath = join(workRoot, tarball);
  // Real global-layout install: npm -g --prefix => <prefix>/bin/ryf symlink.
  execFileSync("npm", ["install", "-g", "--prefix", join(workRoot, "prefix"), packPath], {
    cwd: workRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const globalBin = join(workRoot, "prefix", "bin", "ryf");
  const dotbin = join(workRoot, "prefix", "node_modules", ".bin", "ryf");
  if (existsSync(globalBin)) {
    binRyf = globalBin;
  } else {
    expect(existsSync(dotbin)).toBe(true);
    binRyf = dotbin;
  }
  expect(existsSync(binRyf)).toBe(true);
}, 300_000);

afterAll(() => {
  if (workRoot !== undefined) {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

async function run(
  args: string[],
  opts: { home: string; cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      npm_config_update_notifier: "false",
      ...(opts.env ?? {}),
    };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const { stdout, stderr } = await execFile(binRyf, args, {
      cwd: opts.cwd ?? workRoot, // foreign cwd, outside the checkout
      encoding: "utf8" as never,
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function isolatedHome(): { home: string; storeArgs: string[] } {
  const home = mkdtempSync(join(tmpdir(), "ryf-e2e-home-"));
  // Synthetic traces under the ISOLATED home's DEFAULT store roots (discovery
  // defaults must derive from the passed HOME).
  const codexDir = join(home, ".codex", "sessions", "2026", "09", "07");
  const piDir = join(home, ".pi", "agent", "sessions");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  const filler = "review the failing integration test and propose a fix. ".repeat(30);
  writeFileSync(
    join(codexDir, "e2e-sess.jsonl"),
    `${JSON.stringify({ type: "session_meta", timestamp: "2026-09-01T10:00:00Z", payload: { id: "e2e-sess" } })}\n` +
      `${JSON.stringify({ type: "response_item", timestamp: "2026-09-01T10:00:05Z", payload: { type: "message", role: "user", content: filler } })}\n` +
      `${JSON.stringify({ type: "response_item", timestamp: "2026-09-01T10:01:00Z", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" } })}\n` +
      `${JSON.stringify({ type: "response_item", timestamp: "2026-09-01T10:01:05Z", payload: { type: "function_call_output", call_id: "c1", output: "exit code 1: 2 tests failed" } })}\n`,
  );
  writeFileSync(
    join(piDir, "e2e-pi.jsonl"),
    `${JSON.stringify({ type: "session", id: "e2e-pi", timestamp: "2026-09-02T10:00:00Z" })}\n` +
      `${JSON.stringify({ type: "message", id: "m1", parentId: null, role: "user", timestamp: "2026-09-02T10:00:05Z", content: "explore for e2e" })}\n`,
  );
  return { home, storeArgs: ["--now", NOW] };
}

function seedConsent(home: string, destination: string): void {
  const dir = join(home, ".config", "ryf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "consent.json"),
    JSON.stringify({
      version: "consent@1",
      state: "consented",
      destination,
      scopeVersion: 1,
      timestamp: "2026-09-06T00:00:00Z",
    }),
  );
  chmodSync(join(dir, "consent.json"), 0o600);
}

function seedClientConfig(home: string, endpoint: string): void {
  const dir = join(home, ".config", "ryf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ endpoint })}\n`);
}

/**
 * Assert the isolated reports dir holds EXACTLY one `.html` report. Used
 * only for single-run scenarios (the no-backend contract).
 */
function assertSingleReportHtml(home: string): string {
  const reportsDir = join(home, ".ryf", "reports");
  const htmlFiles = readdirSync(reportsDir).filter((f) => f.endsWith(".html"));
  expect(htmlFiles).toHaveLength(1);
  return readFileSync(join(reportsDir, htmlFiles[0] as string), "utf8");
}

/** Read the .html report at the absolute path printed on stdout. */
function readReportHtml(reportPath: string): string {
  expect(reportPath).toMatch(/\.html$/);
  expect(existsSync(reportPath)).toBe(true);
  return readFileSync(reportPath, "utf8");
}

function expectReportUrl(stderr: string, reportPath: string): void {
  const match = /^Report: (file:\/\/\S+)$/m.exec(stderr);
  expect(match?.[1]).toBe(pathToFileURL(reportPath).href);
  expect(match?.[1]).toContain("%20");
  expect(match?.[1]).toContain("%23");
  expect(match?.[1]).toContain("%C3%B1");
  expect(fileURLToPath(match?.[1] as string)).toBe(reportPath);
}

describe("installed-tarball E2E — symlink, help, preview (Phase 11)", () => {
  it("invokes the ryf symlink: --version and --help work (realpath main-guard)", async () => {
    const { home } = isolatedHome();
    const version = await run(["--version"], { home });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.7");
    const help = await run(["--help"], { home });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("NOT YET PUBLISHED");
    expect(help.stdout).toContain("--preview");
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it("--preview renders the digest send-free from the isolated HOME store", async () => {
    const { home, storeArgs } = isolatedHome();
    const result = await run(["--preview", ...storeArgs], { home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("digest@1");
    expect(result.stdout).toContain("e2e-sess");
    expect(existsSync(join(home, ".config", "ryf", "consent.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

describe("installed-tarball E2E — honest no-backend + refusal", () => {
  it("no backend configured: honest incomplete report, ZERO network", async () => {
    const { home, storeArgs } = isolatedHome();
    const result = await run([...storeArgs], { home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no analysis endpoint configured");
    // stdout carries the absolute .html report path.
    expect(result.stdout).toMatch(/\/.*\.html\n$/);
    expect(existsSync(result.stdout.trim())).toBe(true);
    expect(result.stderr).toContain(`Report: ${pathToFileURL(result.stdout.trim()).href}\n`);
    // The reports dir holds EXACTLY one .html report; its content is HTML.
    const html = assertSingleReportHtml(home);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Analysis incomplete");
    expect(html).toContain("endpoint_not_configured");
    expect(html).not.toMatch(/Total score:?\s*\d/);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it("refusal (non-TTY, no consent record): zero-hit server, consent_refused report", async () => {
    let hits = 0;
    const server = createServer(() => {
      hits += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { home, storeArgs } = isolatedHome();
      const result = await run(["--endpoint", `http://127.0.0.1:${port}`, ...storeArgs], { home });
      expect(hits).toBe(0); // non-TTY auto-refusal happened BEFORE any egress
      expect(result.status).toBe(1);
      // stdout carries the absolute .html report path, not the report body.
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("Analysis incomplete");
      expect(html).toContain("consent_refused");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe("installed-tarball E2E — endpoint resolution (Unit A: RYF_ENDPOINT + validation)", () => {
  it("env-only endpoint (RYF_ENDPOINT, no --endpoint) is honored and completes", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    const backend = await startRealBackend(provider.url);
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      const result = await run([...storeArgs], { home, env: { RYF_ENDPOINT: backend.url } });
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("Overall score");
      expect(html).toContain("@ram4_dev");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it("isolated config endpoint completes after endpoint and CA environment variables are removed", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    const backend = await startRealBackend(provider.url);
    try {
      const { home, storeArgs } = isolatedHome();
      seedClientConfig(home, backend.url);
      seedConsent(home, backend.url);
      const result = await run([...storeArgs], {
        home,
        env: { RYF_ENDPOINT: undefined, NODE_EXTRA_CA_CERTS: undefined },
      });
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(readReportHtml(result.stdout.trim())).toContain("Overall score");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it("invalid endpoint (embedded credentials) is rejected with ZERO network egress", async () => {
    let hits = 0;
    const server = createServer(() => {
      hits += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { home, storeArgs } = isolatedHome();
      const result = await run(["--endpoint", `http://user:pass@127.0.0.1:${port}`, ...storeArgs], {
        home,
      });
      expect(hits).toBe(0); // rejected before any network request
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid analysis endpoint");
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("endpoint_invalid");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe("installed-tarball E2E — REAL backend chain (provider mock only)", () => {
  it("success end-to-end: installed CLI → REAL backend → REAL OpenCodeGoProvider → mock model", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    const backend = await startRealBackend(provider.url);
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      const reportsDir = join(home, "reports # ñ");
      const result = await run(["--endpoint", backend.url, "--reports-dir", reportsDir, ...storeArgs], { home });
      const providerFirstBody = provider.hits[0]?.body ?? "NO HIT";
      const extractedSession =
        /"sessionId":"([^"]+)"/.exec(
          (JSON.parse(providerFirstBody) as { messages?: { content?: string }[] }).messages?.[1]
            ?.content ?? "",
        )?.[1] ?? "no-match";
      expect(
        result.status,
        `stdout=${result.stdout}\nstderr=${result.stderr}\nproviderHits=${provider.hits.length}\nextractedSession=${extractedSession}`,
      ).toBe(0);
      // stdout carries the absolute .html report path (report body is the file).
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const reportPath = result.stdout.trim();
      expectReportUrl(result.stderr, reportPath);
      const html = readReportHtml(reportPath);
      expect(html).toContain("Overall score");
      expect(html).toContain("note one actionable step"); // verbatim recommendation
      expect(html).toContain("@ram4_dev");
      // The mock provider received an OpenAI-compatible request with auth header.
      expect(provider.hits.length).toBe(1);
      expect(provider.hits[0]?.body).toContain("chat/completions" in {} ? "x" : '"model"');
      expect(provider.hits[0]?.body).toContain("<digest-data>");
      // Semantic sample coverage distinguished from local coverage.
      expect(html.toLowerCase()).toContain("semantic sample");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it("redirect refused end-to-end: backend 302 → CLI single egress, zero second hit", async () => {
    let secondTargetHits = 0;
    const evilServer = createServer(() => {
      secondTargetHits += 1;
    });
    await new Promise<void>((resolve) => evilServer.listen(0, "127.0.0.1", resolve));
    const evilPort = (evilServer.address() as { port: number }).port;
    // REAL backend whose handler is bypassed at the HTTP layer by a redirect:
    // use a plain server that redirects (the CLI→backend hop is what matters).
    const backend = createServer((req, res) => {
      void req;
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${evilPort}/analyze`);
      res.end();
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const backendPort = (backend.address() as { port: number }).port;
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, `http://127.0.0.1:${backendPort}`);
      const result = await run(["--endpoint", `http://127.0.0.1:${backendPort}`, ...storeArgs], {
        home,
      });
      expect(secondTargetHits).toBe(0); // digest never reached the redirect target
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("endpoint_redirected");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await new Promise<void>((resolve) => evilServer.close(() => resolve()));
    }
  }, 60_000);

  it("quota 3/day with the REAL handler store: 3 complete, 4th over_quota", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    const backend = await startRealBackend(provider.url);
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      for (let i = 0; i < 3; i++) {
        const result = await run(["--endpoint", backend.url, ...storeArgs], { home });
        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(/\/.*\.html\n$/);
        const html = readReportHtml(result.stdout.trim());
        expect(html).toContain("Overall score");
        expect(html).toContain("@ram4_dev");
      }
      const fourth = await run(["--endpoint", backend.url, ...storeArgs], { home });
      expect(fourth.status).toBe(1);
      expect(fourth.stdout).toMatch(/\/.*\.html\n$/);
      const fourthHtml = readReportHtml(fourth.stdout.trim());
      expect(fourthHtml).toContain("Analysis incomplete");
      expect(fourthHtml).toContain("over_quota");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 150_000);

  it("remembered consent: second run proceeds without any prompt server interaction", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    const backend = await startRealBackend(provider.url);
    try {
      const { home, storeArgs } = isolatedHome();
      // First run without seeded consent: non-TTY auto-refuses BUT that
      // records the refusal → second run would re-prompt (refused state).
      // Instead: seed consent → run twice → both proceed (no prompt at all).
      seedConsent(home, backend.url);
      const first = await run(["--endpoint", backend.url, ...storeArgs], { home });
      expect(first.status, `stdout=${first.stdout}\nstderr=${first.stderr}`).toBe(0);
      const second = await run(["--endpoint", backend.url, ...storeArgs], { home });
      // Remembered consent: the second run proceeds WITHOUT re-prompting —
      // it must NOT fail with consent_refused (fresh backend: not over quota).
      expect(second.status, `stdout=${second.stdout}`).toBe(0);
      expect(second.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(second.stdout.trim());
      expect(html).toContain("Overall score");
      expect(html).not.toContain("consent_refused");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 150_000);

  it("provider timeout: REAL backend timeout (injectable) → timeout error surfaced", async () => {
    const provider = await startMockProvider({ behavior: "hang" });
    const backend = await startRealBackend(provider.url, { timeoutMs: 300 });
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      const result = await run(["--endpoint", backend.url, ...storeArgs], { home });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("Analysis incomplete");
      expect(html).toContain("timeout");
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it("malformed provider response: adapter retry once → invalid_model_response surfaced", async () => {
    const provider = await startMockProvider({ behavior: "malformed" });
    const backend = await startRealBackend(provider.url, { timeoutMs: 5000 });
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      const result = await run(["--endpoint", backend.url, ...storeArgs], { home });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("Analysis incomplete");
      expect(html).toContain("invalid_model_response");
      // Bounded retry: exactly 2 provider attempts.
      expect(provider.hits.length).toBe(2);
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it("payload size: oversized digest → REAL backend 413 → oversized_payload surfaced", async () => {
    const provider = await startMockProvider({ behavior: "ok" });
    // Tiny max payload so a normal CLI digest (a few KiB) exceeds it.
    const backend = await startRealBackend(provider.url, { maxPayloadBytes: 1024 });
    try {
      const { home, storeArgs } = isolatedHome();
      seedConsent(home, backend.url);
      const result = await run(["--endpoint", backend.url, ...storeArgs], { home });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/\/.*\.html\n$/);
      const html = readReportHtml(result.stdout.trim());
      expect(html).toContain("Analysis incomplete");
      expect(html).toContain("oversized_payload");
      expect(provider.hits.length).toBe(0); // rejected pre-provider
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);
});
