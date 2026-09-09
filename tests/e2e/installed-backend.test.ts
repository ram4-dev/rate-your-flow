/**
 * Unit C E2E — REAL installed tarball + env-only CLI (task 3.5).
 *
 * Chain under test (NO code paths mocked except the EXTERNAL model):
 *   npm run build → npm pack → npm install -g --prefix <prefix> <tarball> →
 *   INSTALLED `node <prefix>/lib/node_modules/rate-your-flow/dist/backend/main.js`
 *   (the real operator bootstrap, launched from the installed package) with
 *   explicit env + mock provider endpoint → INSTALLED `ryf` bin symlink run with
 *   ONLY `RYF_ENDPOINT=<installed backend url>` and NO `--endpoint`, from an
 *   ISOLATED HOME.
 *
 * Asserts:
 *   - the INSTALLED backend serves GET /healthz 200 (loopback + PORT honored);
 *   - a real POST /analyze round-trip through the INSTALLED binary returns
 *     outcome "complete" and reaches the mock provider (the only mocked piece);
 *   - the env-only RYF_ENDPOINT CLI run completes and prints an absolute .html
 *     report path on stdout (this is Unit A task 1.1, wired into src/cli/bin.ts);
 *   - a missing-config bootstrap exits non-zero with a named diagnostic and no
 *     listening socket.
 *
 * If env-only RYF_ENDPOINT were genuinely not wired in this worktree, this would
 * fail loudly (report the real run result) rather than falling back to
 * `--endpoint`.
 */
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const NOW = "2026-09-07T12:00:00Z";

/** Valid OpenAI-compatible body; citations resolved from the incoming digest. */
function providerCompleteBody(requestBody: string): string {
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
    // fall back to "unknown" (validator rejects, correctly)
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
        notes: "note one",
      },
      {
        dimension: "communication",
        score: 60,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note two",
      },
      {
        dimension: "context-efficiency",
        score: 75,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note three",
      },
      {
        dimension: "productivity",
        score: 65,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note four",
      },
      {
        dimension: "hygiene",
        score: 85,
        evaluable: true,
        evidence: [{ sessionId, line: 1 }],
        notes: "note five",
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

interface BackendProcess {
  proc: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  url: string;
}

let workRoot = "";
let binRyf = "";
let installedBackendMain = "";
let mockProvider: Server;
let mockUrl = "";
const mockHits: { body: string }[] = [];
let backend: BackendProcess | null = null;

async function freePort(): Promise<number> {
  const s = createServer();
  return new Promise<number>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${url}/healthz`);
        if (res.status === 200 && (await res.text()) === "ok") {
          resolve();
          return;
        }
      } catch {
        // not up yet; keep polling
      }
      if (Date.now() > deadline) {
        reject(new Error(`bootstrap did not become healthy at ${url} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 150);
    };
    void poll();
  });
}

async function launchInstalledBackend(
  env: Record<string, string | undefined>,
): Promise<BackendProcess> {
  const port = Number(env.PORT);
  const proc = spawn("node", [installedBackendMain], {
    cwd: workRoot,
    env: { ...process.env, ...(env as NodeJS.ProcessEnv) },
  });
  const handle: BackendProcess = {
    proc,
    stdout: "",
    stderr: "",
    url: `http://127.0.0.1:${port}`,
  };
  proc.stdout.on("data", (chunk: Buffer) => (handle.stdout += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (handle.stderr += chunk.toString()));
  await waitForHealth(handle.url);
  return handle;
}

async function stopBackend(handle: BackendProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (handle.proc.exitCode !== null) {
      resolve();
      return;
    }
    handle.proc.once("exit", () => resolve());
    handle.proc.kill("SIGTERM");
    setTimeout(() => {
      if (handle.proc.exitCode === null) handle.proc.kill("SIGKILL");
    }, 5_000).unref();
  });
}

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ryf-be-home-"));
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
  return home;
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

/** Invoke the INSTALLED `ryf` bin symlink (env-only RYF_ENDPOINT, no --endpoint). */
async function runInstalledCli(
  args: string[],
  home: string,
  extraEnv: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFile(binRyf, args, {
      cwd: workRoot,
      encoding: "utf8" as never,
      env: {
        ...process.env,
        HOME: home,
        npm_config_update_notifier: "false",
        ...extraEnv,
      } as NodeJS.ProcessEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), "ryf-be-e2e-"));
  const prefix = join(workRoot, "prefix");

  execFileSync("npm", ["run", "build"], { cwd: REPO, encoding: "utf8" });
  const packOut = execFileSync("npm", ["pack", "--pack-destination", workRoot], {
    cwd: REPO,
    encoding: "utf8",
  });
  const tarball = packOut.trim().split("\n").pop() as string;
  const packPath = join(workRoot, tarball);
  execFileSync("npm", ["install", "-g", "--prefix", prefix, packPath], {
    cwd: workRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });

  // Installed package root + backend main.js from the installed prefix.
  const installedPkg = join(prefix, "lib", "node_modules", "rate-your-flow");
  installedBackendMain = join(installedPkg, "dist", "backend", "main.js");
  if (!existsSync(installedBackendMain)) {
    installedBackendMain = join(
      prefix,
      "node_modules",
      "rate-your-flow",
      "dist",
      "backend",
      "main.js",
    );
  }
  expect(existsSync(installedBackendMain)).toBe(true);

  // Installed `ryf` bin symlink (global layout) with its direct-run realpath guard.
  const globalBin = join(prefix, "bin", "ryf");
  const dotbin = join(prefix, "node_modules", ".bin", "ryf");
  if (existsSync(globalBin)) {
    binRyf = globalBin;
  } else {
    expect(existsSync(dotbin)).toBe(true);
    binRyf = dotbin;
  }
  expect(existsSync(binRyf)).toBe(true);

  // MOCK external model boundary (the ONLY mocked piece).
  mockProvider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mockHits.push({ body });
      res.setHeader("content-type", "application/json");
      res.end(providerCompleteBody(body));
    });
  });
  await new Promise<void>((resolve) => mockProvider.listen(0, "127.0.0.1", resolve));
  const mockPort = (mockProvider.address() as AddressInfo).port;
  mockUrl = `http://127.0.0.1:${mockPort}/v1`;

  const backendPort = await freePort();
  backend = await launchInstalledBackend({
    PORT: String(backendPort),
    RYF_COUNTER_MODE: "dev-memory",
    RYF_PROVIDER_ENDPOINT: mockUrl,
    RYF_PROVIDER_MODEL: "glm-5.3-flash",
    OPENCODE_GO_API_KEY: "dummy-vault-handle",
  });
}, 300_000);

afterAll(async () => {
  if (backend !== null) {
    await stopBackend(backend);
    backend = null;
  }
  if (mockProvider !== undefined) {
    await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
  }
  if (workRoot !== "") {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

describe("installed-backend E2E — REAL installed tarball + env-only CLI (task 3.5)", () => {
  it("INSTALLED backend launches, binds loopback, honors PORT, serves /healthz 200", async () => {
    expect(backend).not.toBeNull();
    const res = await fetch(`${backend!.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(backend!.stderr).not.toContain("listening on http://0.0.0.0");
    expect(backend!.stdout).toContain("127.0.0.1");
    const port = Number(backend!.url.split(":").pop());
    expect(port).toBeGreaterThan(0);
  }, 30_000);

  it("INSTALLED backend completes a real /analyze round-trip through the mock provider", async () => {
    const digest = {
      schema: "digest@1",
      counters: { sessions: 1 },
      eventSequences: [{ sessionId: "e2e-sess", events: [{ line: 1, kind: "message" }] }],
      episodes: [],
      citedSnippets: [{ sessionId: "e2e-sess", line: 1, text: "evidence" }],
    };
    const res = await fetch(`${backend!.url}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "analysis@1", installUUID: "uuid-c", digest }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outcome?: string; total?: number };
    expect(json.outcome).toBe("complete");
    expect(json.total).toBe(71);
    // The round-trip reached the mock provider through the installed binary.
    expect(mockHits.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("missing configuration on the INSTALLED bootstrap: non-zero, named diagnostic, no socket", async () => {
    const port = await freePort();
    const proc = spawn("node", [installedBackendMain], {
      cwd: workRoot,
      env: {
        ...process.env,
        PORT: String(port),
        RYF_PROVIDER_ENDPOINT: mockUrl,
      } as NodeJS.ProcessEnv,
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code: number = await new Promise((resolve) => {
      proc.on("close", (c) => resolve(c ?? 1));
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("RYF_COUNTER_MODE");
    // No socket opened: the port is not bound (healthz refuses).
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  }, 30_000);

  it("env-only RYF_ENDPOINT CLI run (NO --endpoint) completes against the INSTALLED backend", async () => {
    const home = isolatedHome();
    seedConsent(home, backend!.url);
    const result = await runInstalledCli(["--now", NOW], home, { RYF_ENDPOINT: backend!.url });
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/\/.*\.html\n$/);
    const reportPath = result.stdout.trim();
    expect(existsSync(reportPath)).toBe(true);
    const html = readFileSync(reportPath, "utf8");
    expect(html).toContain("Overall score");
    // The /analyze round-trip went through the installed binary and hit the mock.
    expect(mockHits.length).toBeGreaterThanOrEqual(1);
    rmSync(home, { recursive: true, force: true });
  }, 90_000);
});
