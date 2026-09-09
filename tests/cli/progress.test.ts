/**
 * Unit A stderr progress (task 1.6): reporter behavior + runRyf wiring.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runRyf } from "../../src/cli/bin.js";
import { createProgressReporter, type ProgressReporter } from "../../src/cli/progress.js";

const STORE_ROOT = fileURLToPath(new URL("../fixtures/stores", import.meta.url));
const NOW = "2026-09-07T12:00:00Z";

const homes: string[] = [];
let server: Server;

afterEach(async () => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) =>
    server !== undefined ? server.close(() => resolve()) : resolve(),
  );
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ryf-prog-"));
  homes.push(home);
  return home;
}

function baseArgs(): string[] {
  return ["--codex-dir", `${STORE_ROOT}/codex`, "--pi-dir", `${STORE_ROOT}/pi`, "--now", NOW];
}

/** A server that returns a valid complete analysis@1 response. */
async function startCompleteServer(): Promise<string> {
  server = createServer((_req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function capturingReporter(): ProgressReporter & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    stage: (name) => events.push(`stage:${name}`),
    onProgress: (processed, total) => events.push(`progress:${processed}/${total}`),
    waitingFor: (endpoint) => events.push(`waiting:${endpoint}`),
    waitingDone: () => events.push("waitingDone"),
    finish: () => events.push("finish"),
    abort: () => events.push("abort"),
  };
}

describe("createProgressReporter (nonTTY)", () => {
  it("stage emits one deduplicated concise line with no timer or fraction", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: false },
    });
    reporter.stage("Preparing analysis");
    reporter.stage("Preparing analysis"); // deduplicated: no second line
    const out = chunks.join("");
    expect(out.split("\n").filter((line) => line !== "")).toHaveLength(1);
    expect(out).toContain("Preparing analysis");
    expect(out).not.toMatch(/\d*\.\d+s/); // no elapsed timer
    expect(out).not.toMatch(/\d+%/); // no fraction
  });

  it("waitingFor names the endpoint", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: false },
    });
    reporter.waitingFor("http://127.0.0.1:1234");
    expect(chunks.join("")).toContain("http://127.0.0.1:1234");
  });
});

describe("createProgressReporter (TTY)", () => {
  it("finish clears the bar and writes a done line with no leftover artifacts", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: true },
    });
    reporter.onProgress(1, 2);
    reporter.finish();
    const out = chunks.join("");
    expect(out).toContain("done");
    expect(out).toContain("\x1b[2K"); // bar line cleared/redrawn
  });

  it("abort prints failure wording, never 'done'", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: true },
    });
    reporter.onProgress(1, 2);
    reporter.abort();
    const out = chunks.join("");
    expect(out).toContain("analysis not completed");
    expect(out).not.toContain("done");
  });

  it("onProgress renders actual processed/total counts beside the bar", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: true },
    });
    reporter.onProgress(123, 686);
    expect(chunks.join("")).toContain("123/686");
  });
});

describe("createProgressReporter abort stream order", () => {
  it("abort clears the live line BEFORE the failure message (never joined)", () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: true },
    });
    reporter.stage("Preparing analysis"); // establishes a live TTY line
    reporter.abort();
    const joined = chunks.join("");
    // The clear sequence must precede the failure message so the message lands on
    // its own line and is not appended onto the still-visible "Preparing analysis".
    expect(joined).toContain("\r\x1b[2Kryf: analysis not completed");
    // The failure wording is emitted exactly once, never joined into the stage line.
    expect(joined.match(/ryf: analysis not completed/g)).toHaveLength(1);
  });

  it("abort with no live line leaves no stray clear/join and still removes listeners", () => {
    const before = process.listenerCount("SIGINT");
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      stream: { write: (c) => (chunks.push(String(c)), true), isTTY: true },
      wireSignals: true,
    });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    reporter.abort(); // no prior TTY line → currentLine === ""
    expect(chunks.join("")).toBe(""); // no stray clear or message join
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("createProgressReporter signal cleanup", () => {
  it("wireSignals registers and finish() removes the signal listeners (no leak)", () => {
    const before = process.listenerCount("SIGINT");
    const reporter = createProgressReporter({
      stream: { write: () => true, isTTY: false },
      wireSignals: true,
    });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    reporter.finish();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("abort() also removes the signal listeners (exception/abort cleanup)", () => {
    const before = process.listenerCount("SIGTERM");
    const reporter = createProgressReporter({
      stream: { write: () => true, isTTY: false },
      wireSignals: true,
    });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    reporter.abort();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("runRyf progress wiring (1.6)", () => {
  it("onProgress fires per file, emits Preparing analysis before sync build, and names the endpoint during the wait", async () => {
    const url = await startCompleteServer();
    const home = freshHome();
    const reporter = capturingReporter();
    const result = await runRyf(["--endpoint", url, ...baseArgs()], {
      home,
      consentPrompt: async () => true,
      progress: reporter,
    });
    expect(result.mode).toBe("complete");
    // Immediate first milestone BEFORE the metrics loop.
    expect(reporter.events[0]).toBe("stage:Reading sessions…");
    const progressCalls = reporter.events.filter((e) => e.startsWith("progress:"));
    expect(progressCalls).toHaveLength(6);
    expect(progressCalls).toContain("progress:6/6");
    // The reading milestone precedes the per-file ticks.
    const readingIdx = reporter.events.indexOf("stage:Reading sessions…");
    const firstTickIdx = reporter.events.findIndex((e) => e.startsWith("progress:"));
    expect(readingIdx).toBeGreaterThanOrEqual(0);
    expect(firstTickIdx).toBeGreaterThan(readingIdx);
    expect(reporter.events).toContain("stage:Preparing analysis");
    expect(reporter.events).toContain(`waiting:${url}`);
    expect(reporter.events).toContain("waitingDone");
  });

  it("zero-file case emits the reading stage once and advances without hanging", async () => {
    const url = await startCompleteServer();
    const home = freshHome();
    // Point discovery at an EMPTY store root (zero session files).
    const emptyStore = mkdtempSync(join(tmpdir(), "ryf-prog-empty-"));
    homes.push(emptyStore);
    const reporter = capturingReporter();
    const result = await runRyf(
      [
        "--endpoint",
        url,
        "--days",
        "1",
        "--codex-dir",
        emptyStore,
        "--pi-dir",
        emptyStore,
        "--now",
        NOW,
      ],
      {
        home,
        consentPrompt: async () => true,
        progress: reporter,
      },
    );
    expect(result.mode).toBe("complete");
    // Reading stage emitted exactly once; zero per-file progress ticks.
    expect(reporter.events.filter((e) => e === "stage:Reading sessions…")).toHaveLength(1);
    expect(reporter.events.filter((e) => e.startsWith("progress:"))).toHaveLength(0);
    expect(reporter.events).toContain("stage:Preparing analysis");
  });
});
