/**
 * 9.1/9.2 RED: CLI wiring — flags behavior (--preview send-free, --days,
 * --endpoint dev override, --json), default pipeline (discover → digest →
 * consent/preview → analyze → report), honest endpoint-unreachable reporting.
 * bin is testable: runRyf(args, options) returns a structured result.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, runRyf } from "../../src/cli/bin.js";

const STORE_ROOT = fileURLToPath(new URL("../fixtures/stores", import.meta.url));
const NOW = "2026-09-07T12:00:00Z";

let server: Server;

beforeEach(async () => {
  server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ryf-bin-"));
}

function baseArgs(home: string): { home: string; storeArgs: string[] } {
  return {
    home,
    storeArgs: ["--codex-dir", `${STORE_ROOT}/codex`, "--pi-dir", `${STORE_ROOT}/pi`, "--now", NOW],
  };
}

/** A stub server that returns a valid complete analysis@1 response. */
function startCompleteServer(): Promise<{ url: string }> {
  return new Promise((resolve) => {
    server.close();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [
              { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n1" },
              { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n2" },
              {
                dimension: "context-efficiency",
                score: 75,
                evaluable: true,
                evidence: [],
                notes: "n3",
              },
              { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n4" },
              { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n5" },
            ],
            total: 71,
            confidenceNote: "descriptive only",
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Run main() with an injectable HOME and capture stdout/stderr, then
 * restore env + stream spies. The HOME is supplied via process.env because
 * main() reads HOME directly (not injected through options).
 */
/** Seed a remembered-consent record so main() proceeds without a prompt. */
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
}

async function runMainCapture(
  args: string[],
  home = freshHome(),
  seedConsentFor?: string,
): Promise<{ stdout: string; stderr: string; home: string }> {
  if (seedConsentFor !== undefined) {
    seedConsent(home, seedConsentFor);
  }
  const prevHome = process.env.HOME;
  const out: string[] = [];
  const err: string[] = [];
  process.env.HOME = home;
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  try {
    await main(args);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out.join(""), stderr: err.join(""), home };
}

describe("runRyf — preview (9.1)", () => {
  it("--preview renders the digest send-free (no consent, no egress)", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const result = await runRyf(["--preview", ...storeArgs], { home });
    expect(result.mode).toBe("preview");
    if (result.mode === "preview") {
      expect(result.preview).toContain("digest@1");
    }
    // No consent file created, nothing sent (no server hit possible anyway).
    expect(existsSync(join(home, ".config", "ryf", "consent.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("--preview via main() emits NO lifecycle progress on stderr (silent)", async () => {
    const home = freshHome();
    const { stdout, stderr } = await runMainCapture(
      ["--preview", ...baseArgs(home).storeArgs],
      home,
    );
    expect(stdout).toContain("digest@1");
    expect(stderr).not.toMatch(/ryf: (Reading|Preparing|Waiting|done)/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("runRyf — client configuration early exits", () => {
  it("--help and --version stay usable when config.json is malformed", async () => {
    const home = freshHome();
    const dir = join(home, ".config", "ryf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");

    await expect(runRyf(["--help"], { home })).resolves.toMatchObject({ mode: "help" });
    await expect(runRyf(["--version"], { home })).resolves.toMatchObject({ mode: "version", version: "0.1.7" });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("runRyf — 200-incomplete envelope preservation (root E2E review regression)", () => {
  it.each([
    [
      "timeout",
      { schema: "analysis@1", outcome: "incomplete", error: { code: "timeout" } } as never,
    ],
    [
      "over_quota",
      {
        schema: "analysis@1",
        outcome: "incomplete",
        error: { code: "over_quota", retryAfterSeconds: 30 },
      } as never,
    ],
  ])(
    "HTTP 200 incomplete envelope preserves code %s (not flattened to invalid_model_response)",
    async (code, body) => {
      server.close();
      server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
      const home = freshHome();
      const { storeArgs } = baseArgs(home);
      const result = await runRyf(["--endpoint", url, ...storeArgs], {
        home,
        consentPrompt: async () => true,
      });
      expect(result.mode).toBe("incomplete");
      if (result.mode === "incomplete") {
        expect(result.errorCode).toBe(code);
        if (code === "over_quota") {
          expect(result.retryAfterSeconds).toBe(30);
        }
      }
      rmSync(home, { recursive: true, force: true });
    },
  );

  it("200 incomplete with UNKNOWN code still degrades honestly (invalid_model_response)", async () => {
    server.close();
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          schema: "analysis@1",
          outcome: "incomplete",
          error: { code: "not_a_code" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const result = await runRyf(["--endpoint", url, ...storeArgs], {
      home,
      consentPrompt: async () => true,
    });
    expect(result.mode).toBe("incomplete");
    if (result.mode === "incomplete") {
      expect(result.errorCode).toBe("invalid_model_response");
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("runRyf — default pipeline (9.1)", () => {
  it("consent granted → analyze via endpoint → complete report saved", async () => {
    server.close();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [
              { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n1" },
              { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n2" },
              {
                dimension: "context-efficiency",
                score: 75,
                evaluable: true,
                evidence: [],
                notes: "n3",
              },
              { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n4" },
              { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n5" },
            ],
            total: 71,
            confidenceNote: "descriptive only",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    const result = await runRyf(["--endpoint", url, "--reports-dir", reportsDir, ...storeArgs], {
      home,
      consentPrompt: async () => true,
    });
    expect(result.mode).toBe("complete");
    if (result.mode === "complete") {
      expect(result.total).toBe(71);
      expect(result.reportPath).toBeDefined();
      // The saved file is the HTML document at a .html path; the markdown
      // renderer output is still carried on the result for --json.
      expect(result.reportPath as string).toMatch(/\.html$/);
      expect(isAbsolute(result.reportPath as string)).toBe(true);
      expect(existsSync(result.reportPath as string)).toBe(true);
      const html = readFileSync(result.reportPath as string, "utf8");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Overall score");
      expect(html).toContain("<strong>71</strong> /100");
      expect(html).toContain("@ram4_dev");
      expect(html).toContain("Semantic sample coverage");
      expect(result.markdown).toContain("# Rate Your Flow — analysis report");
      expect(result.markdown).toContain("Total score: 71");
    }
    // Consent recorded for the destination.
    expect(readFileSync(join(home, ".config", "ryf", "consent.json"), "utf8")).toContain(
      "consented",
    );
    rmSync(home, { recursive: true, force: true });
  });

  it("consent refused → local-only incomplete report, no egress", async () => {
    let egress = 0;
    server.close();
    server = createServer((_req, res) => {
      egress += 1;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    const result = await runRyf(["--endpoint", url, "--reports-dir", reportsDir, ...storeArgs], {
      home,
      consentPrompt: async () => false,
    });
    expect(egress).toBe(0);
    expect(result.mode).toBe("incomplete");
    if (result.mode === "incomplete") {
      // Incomplete report written as a .html document, never a fabricated total.
      expect(result.reportPath as string).toMatch(/\.html$/);
      expect(isAbsolute(result.reportPath as string)).toBe(true);
      expect(existsSync(result.reportPath as string)).toBe(true);
      const html = readFileSync(result.reportPath as string, "utf8");
      expect(html).toContain("Analysis incomplete");
      expect(html).toContain("consent_refused");
      expect(html).not.toMatch(/Total score:?\s*\d/);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("consent remembered on second run (no re-prompt)", async () => {
    server.close();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [
              { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n" },
              { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n" },
              {
                dimension: "context-efficiency",
                score: 75,
                evaluable: true,
                evidence: [],
                notes: "n",
              },
              { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n" },
              { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n" },
            ],
            total: 71,
            confidenceNote: "d",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    let prompts = 0;
    const prompt = async (): Promise<boolean> => {
      prompts += 1;
      return true;
    };
    await runRyf(["--endpoint", url, "--reports-dir", reportsDir, ...storeArgs], {
      home,
      consentPrompt: prompt,
    });
    await runRyf(["--endpoint", url, "--reports-dir", reportsDir, ...storeArgs], {
      home,
      consentPrompt: prompt,
    });
    expect(prompts).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("9.2/9.3 unreachable endpoint: honest error surfaced, no fake success", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    const result = await runRyf(
      ["--endpoint", "http://127.0.0.1:1", "--reports-dir", reportsDir, ...storeArgs],
      { home, consentPrompt: async () => true },
    );
    expect(result.mode).toBe("incomplete");
    if (result.mode === "incomplete") {
      expect(result.errorCode).toBe("endpoint_unreachable");
      expect(result.reportPath as string).toMatch(/\.html$/);
      expect(isAbsolute(result.reportPath as string)).toBe(true);
      const html = readFileSync(result.reportPath as string, "utf8");
      expect(html).toContain("endpoint_unreachable");
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("relative --reports-dir regression: the printed/saved path is always absolute", async () => {
    const { url } = await startCompleteServer();
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    // Pass a relative reports dir (never absolute). The resolved report path
    // must still be absolute and the .html file must exist.
    const result = await runRyf(["--endpoint", url, "--reports-dir", "reports", ...storeArgs], {
      home,
      consentPrompt: async () => true,
    });
    expect(result.mode).toBe("complete");
    if (result.mode === "complete") {
      expect(isAbsolute(result.reportPath)).toBe(true);
      expect(result.reportPath).toMatch(/\.html$/);
      expect(existsSync(result.reportPath)).toBe(true);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("main() prints the absolute .html report path (not the report body)", async () => {
    const { url } = await startCompleteServer();
    const home = freshHome();
    const { stdout } = await runMainCapture(
      ["--endpoint", url, ...baseArgs(home).storeArgs],
      home,
      url,
    );
    expect(stdout).toMatch(/\/.*\.html\n$/);
    expect(isAbsolute(stdout.trim())).toBe(true);
    expect(existsSync(stdout.trim())).toBe(true);
    expect(stdout).not.toContain("Total score: 71");
    rmSync(home, { recursive: true, force: true });
  });

  it("main() emits an encoded report URL on stderr while stdout remains the absolute path", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const { url } = await startCompleteServer();
    const reportsDir = join(home, "reports # ñ");
    const { stdout, stderr } = await runMainCapture(
      ["--endpoint", url, "--reports-dir", reportsDir, ...storeArgs],
      home,
      url,
    );
    const reportPath = stdout.trim();

    expect(stdout).toBe(`${reportPath}\n`);
    expect(stderr).toContain(`Report: ${pathToFileURL(reportPath).href}\n`);
    expect(stderr).toContain("%20");
    expect(stderr).toContain("%23");
    expect(stderr).toContain("%C3%B1");
    rmSync(home, { recursive: true, force: true });
  });

  it("main() --json adds reportUrl without putting a human URL on stdout", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const { url } = await startCompleteServer();
    const { stdout, stderr } = await runMainCapture(["--endpoint", url, "--json", ...storeArgs], home, url);
    const result = JSON.parse(stdout) as { reportPath: string; reportUrl?: string };

    expect(result.reportUrl).toBe(pathToFileURL(result.reportPath).href);
    expect(stdout).not.toContain("Report: file:");
    expect(stderr).toContain(`Report: ${result.reportUrl}\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it("main() emits a report URL for an incomplete saved report", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports # ñ");
    const { stdout, stderr } = await runMainCapture(
      ["--endpoint", "http://user:pass@127.0.0.1:1", "--reports-dir", reportsDir, ...storeArgs],
      home,
    );
    const reportPath = stdout.trim();

    expect(stdout).toBe(`${reportPath}\n`);
    expect(stderr).toContain(`Report: ${pathToFileURL(reportPath).href}\n`);
    expect(stderr).toContain("invalid analysis endpoint");
    rmSync(home, { recursive: true, force: true });
  });

  it("main() --json keeps markdown AND adds an html field, never labeling HTML as markdown", async () => {
    const { url } = await startCompleteServer();
    const home = freshHome();
    const { stdout } = await runMainCapture(
      ["--endpoint", url, "--json", ...baseArgs(home).storeArgs],
      home,
      url,
    );
    const parsed = JSON.parse(stdout) as { markdown?: string; html?: string };
    expect(typeof parsed.html).toBe("string");
    expect(parsed.html as string).toContain("<!DOCTYPE html>");
    expect(parsed.markdown).toContain("# Rate Your Flow — analysis report");
    expect(parsed.markdown as string).not.toContain("<!DOCTYPE html>");
    rmSync(home, { recursive: true, force: true });
  });

  it("--days narrows the window (older session drops out)", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const result = await runRyf(["--preview", "--days", "1", ...storeArgs], { home });
    expect(result.mode).toBe("preview");
    if (result.mode === "preview") {
      // With a 1-day window, only sessions from 2026-09-07 remain (none in
      // fixtures are that fresh — sess-recent is 2026-09-01). Expect zero
      // selected sessions.
      expect(result.preview).toContain('"sessions":0');
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("runRyf — endpoint resolution (Unit A: read RYF_ENDPOINT, precedence, diagnostics)", () => {
  it("env-only endpoint (RYF_ENDPOINT, no flag) is honored and the analysis completes", async () => {
    server.close();
    server = createServer((req, res) => {
      void req;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [
              { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n" },
              { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n" },
              {
                dimension: "context-efficiency",
                score: 75,
                evaluable: true,
                evidence: [],
                notes: "n",
              },
              { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n" },
              { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n" },
            ],
            total: 71,
            confidenceNote: "d",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const result = await runRyf([...storeArgs], {
      home,
      env: { RYF_ENDPOINT: url },
      consentPrompt: async () => true,
    });
    expect(result.mode).toBe("complete");
    if (result.mode === "complete") {
      expect(result.total).toBe(71);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("flag beats env: request goes to the flag value, env endpoint is never hit", async () => {
    let flagHits = 0;
    let envHits = 0;
    const flagServer = createServer((_req, res) => {
      flagHits += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          schema: "analysis@1",
          outcome: "complete",
          dimensions: [
            { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n" },
            { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n" },
            {
              dimension: "context-efficiency",
              score: 75,
              evaluable: true,
              evidence: [],
              notes: "n",
            },
            { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n" },
            { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n" },
          ],
          total: 71,
          confidenceNote: "d",
        }),
      );
    });
    const envServer = createServer(() => {
      envHits += 1;
    });
    await new Promise<void>((resolve) => flagServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => envServer.listen(0, "127.0.0.1", resolve));
    const flagAddr = flagServer.address();
    const envAddr = envServer.address();
    const flagUrl = `http://127.0.0.1:${typeof flagAddr === "object" && flagAddr !== null ? flagAddr.port : 0}`;
    const envUrl = `http://127.0.0.1:${typeof envAddr === "object" && envAddr !== null ? envAddr.port : 0}`;
    try {
      const home = freshHome();
      const { storeArgs } = baseArgs(home);
      const result = await runRyf(["--endpoint", flagUrl, ...storeArgs], {
        home,
        env: { RYF_ENDPOINT: envUrl },
        consentPrompt: async () => true,
      });
      expect(result.mode).toBe("complete");
      expect(flagHits).toBe(1);
      expect(envHits).toBe(0);
      rmSync(home, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => flagServer.close(() => resolve()));
      await new Promise<void>((resolve) => envServer.close(() => resolve()));
    }
  });

  it("missing configuration: distinct diagnostic, never endpoint_unreachable", async () => {
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    const result = await runRyf(["--reports-dir", reportsDir, ...storeArgs], {
      home,
      env: {},
    });
    expect(result.mode).toBe("incomplete");
    if (result.mode === "incomplete") {
      expect(result.errorCode).toBe("endpoint_not_configured");
      expect(result.errorCode).not.toBe("endpoint_unreachable");
      expect(result.detail).toContain("no analysis endpoint configured");
      const html = readFileSync(result.reportPath as string, "utf8");
      expect(html).toContain("endpoint_not_configured");
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("invalid endpoint: distinct invalid diagnostic, zero network egress", async () => {
    let egress = 0;
    server.close();
    server = createServer(() => {
      egress += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const home = freshHome();
    const { storeArgs } = baseArgs(home);
    const reportsDir = join(home, "reports");
    const result = await runRyf(
      ["--endpoint", "ftp://x", "--reports-dir", reportsDir, ...storeArgs],
      { home, env: {} },
    );
    expect(egress).toBe(0);
    expect(result.mode).toBe("incomplete");
    if (result.mode === "incomplete") {
      expect(result.errorCode).toBe("endpoint_invalid");
      expect(result.detail).toContain("invalid analysis endpoint");
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("consented destination reused: plain run (no flag/env) proceeds via the saved destination", async () => {
    server.close();
    server = createServer((req, res) => {
      void req;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            schema: "analysis@1",
            outcome: "complete",
            dimensions: [
              { dimension: "reliability", score: 70, evaluable: true, evidence: [], notes: "n" },
              { dimension: "communication", score: 60, evaluable: true, evidence: [], notes: "n" },
              {
                dimension: "context-efficiency",
                score: 75,
                evaluable: true,
                evidence: [],
                notes: "n",
              },
              { dimension: "productivity", score: 65, evaluable: true, evidence: [], notes: "n" },
              { dimension: "hygiene", score: 85, evaluable: true, evidence: [], notes: "n" },
            ],
            total: 71,
            confidenceNote: "d",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const home = freshHome();
    seedConsent(home, url);
    const { storeArgs } = baseArgs(home);
    const result = await runRyf([...storeArgs], { home, env: {} });
    expect(result.mode).toBe("complete");
    if (result.mode === "complete") {
      expect(result.total).toBe(71);
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("main — reporter cleanup before final output (Unit A order regression)", () => {
  it("a successful run finishes the reporter (stderr 'done') BEFORE writing the stdout report path", async () => {
    const { url } = await startCompleteServer();
    const home = freshHome();
    seedConsent(home, url);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const log: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c) => (log.push({ stream: "stdout", text: String(c) }), true));
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c) => (log.push({ stream: "stderr", text: String(c) }), true));
    try {
      await main(["--endpoint", url, ...baseArgs(home).storeArgs]);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    const pathIdx = log.findIndex((e) => e.stream === "stdout" && /\.html\n$/.test(e.text));
    const doneIdx = log.findIndex((e) => e.stream === "stderr" && e.text.includes("done"));
    expect(pathIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeLessThan(pathIdx);
  });

  it("an incomplete none-endpoint run aborts the reporter (never 'done') and emits the diagnostic", async () => {
    const home = freshHome();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const log: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c) => (log.push({ stream: "stdout", text: String(c) }), true));
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c) => (log.push({ stream: "stderr", text: String(c) }), true));
    try {
      await main([...baseArgs(home).storeArgs]);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(log.findIndex((e) => e.stream === "stderr" && e.text.includes("done"))).toBe(-1);
    expect(
      log.some((e) => e.stream === "stderr" && e.text.includes("endpoint_not_configured")),
    ).toBe(true);
    expect(log.findIndex((e) => e.stream === "stdout" && /\.html\n$/.test(e.text))).toBeGreaterThan(
      -1,
    );
  });

  it("a thrown error during runRyf aborts the reporter (never 'done'), clears the live line, and propagates", async () => {
    const home = freshHome();
    const prevHome = process.env.HOME;
    const prevEndpoint = process.env.RYF_ENDPOINT;
    process.env.HOME = home;
    delete process.env.RYF_ENDPOINT; // force the missing-endpoint path deterministically
    const errChunks: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c) => (errChunks.push(String(c)), true));
    // Force a TTY stderr so the progress reporter holds a live stage line
    // that abort() must clear before the error propagates (nonTTY stage
    // lines never set a live line to clear).
    const originalTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    try {
      // A reports dir that is a regular FILE makes saveReport throw (mkdir
      // on an existing non-directory => EEXIST) AFTER the reporter has
      // emitted a live stage line, so the abort cleanup must run and the
      // error must propagate to the caller.
      const blockedReportsDir = join(home, "not-a-dir");
      writeFileSync(blockedReportsDir, "occupied");
      await expect(
        main(["--reports-dir", blockedReportsDir, ...baseArgs(home).storeArgs]),
      ).rejects.toThrow();
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevEndpoint === undefined) {
        delete process.env.RYF_ENDPOINT;
      } else {
        process.env.RYF_ENDPOINT = prevEndpoint;
      }
      if (originalTTY === undefined) {
        delete (process.stderr as { isTTY?: boolean }).isTTY;
      } else {
        process.stderr.isTTY = originalTTY;
      }
      errSpy.mockRestore();
    }
    // The abort cleanup ran: failure wording, never the success "done".
    expect(errChunks.some((c) => c.includes("analysis not completed"))).toBe(true);
    expect(errChunks.some((c) => c.includes("done"))).toBe(false);
    // No signal listener leak (abort() removes any listener it registered).
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });
});
