#!/usr/bin/env node
/**
 * CLI entry + testable pipeline (Phase 9, tasks 9.1–9.3 + root CLI review).
 *
 * runRyf(args, options) returns a structured result so tests can assert
 * behavior; main(argv) wires process stdout/exit.
 *
 * Flow: parse flags (strict) → discover → windowed metrics (record
 * timestamps) → digest@1 (48 KiB default) → consent gate (preview + prompt,
 * remembered, re-consent on destination/scope change, refusal ⇒ local-only
 * incomplete report) → postAnalysis (single egress, redirects refused,
 * honest errors) → local report + informational CTA.
 *
 * Endpoint policy (root ruling): NO default backend is assumed. Without
 * `--endpoint`, RYF_ENDPOINT, a persisted client config, or a consented
 * destination, the CLI performs NO network request and returns an honest
 * incomplete result (service not configured; the npm package is not yet
 * published). Explicit endpoints remain consent-bound dev overrides.
 *
 * Response guard (defense in depth): the CLI validates the backend response
 * shape itself (schema, exactly five distinct dimensions, numeric 0-100
 * scores, optional total consistency); malformed backend responses produce
 * an incomplete report — never a crash or a fabricated score.
 */

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOrCreateInstallUUID } from "./install-uuid.js";
import { saveConsent, shouldRePrompt } from "./consent.js";
import { postAnalysis, type AnalysisResult } from "./http-client.js";
import { computeLocalMetrics } from "./metrics.js";
import { buildDigest, renderPreview } from "./digest.js";
import { renderCompleteReport, renderIncompleteReport, saveReport } from "./report.js";
import { renderCompleteHtml, renderIncompleteHtml } from "./report-html.js";
import type { AnalyzeResponse } from "../shared/contracts/analysis@1.js";
import { ANALYSIS_ERROR_CODES } from "../shared/contracts/errors.js";
import type { ConsentRecord } from "./consent.js";
import { RYF_VERSION as VERSION } from "../shared/version.js";
import {
  CLIENT_CONFIG_DIAGNOSTIC,
  INVALID_ENDPOINT_DIAGNOSTIC,
  MISSING_ENDPOINT_DIAGNOSTIC,
  resolveEndpoint,
} from "./endpoint.js";
import { CLIENT_CA_INVALID_CODE, configureEndpointTrust } from "./config.js";
import { createProgressReporter, type ProgressReporter } from "./progress.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
const USAGE = `ryf — Rate Your Flow (npm package rate-your-flow, NOT YET PUBLISHED)

Usage:
  ryf [--preview] [--json] [--days <n>] [--endpoint <url>]
      [--codex-dir <dir>] [--pi-dir <dir>] [--now <iso>] [--reports-dir <dir>]

Commands/flags:
  --preview       Render the redacted digest without sending anything.
  --days <n>      Analysis window in days (default 90).
  --endpoint <u>  Dev backend override (consent-bound). Local demo: run the
                  backend under Portless and pass its URL. Without this flag,
                  RYF_ENDPOINT, or ~/.config/ryf/config.json, ryf makes NO
                  network request and reports that no backend is configured.
  --json          Emit the structured result as JSON.
  --help          Show this help.
  --version       Show the version.

Local install (package not published to npm yet):
  npm pack && npm install -g ./rate-your-flow-<version>.tgz

Reports are saved under ~/.ryf/reports (or --reports-dir).
`;

export const DEFAULT_TIMEOUT_MS_EXPORT = DEFAULT_TIMEOUT_MS;

export type RunResult =
  | { mode: "preview"; preview: string }
  | { mode: "help"; usage: string }
  | { mode: "version"; version: string }
  | { mode: "error"; message: string }
  | {
      mode: "complete";
      total?: number;
      reportPath: string;
      markdown: string;
      html: string;
      digestCoverage: { samplingSelected: number; samplingOmitted: number };
    }
  | {
      mode: "incomplete";
      errorCode: string;
      retryAfterSeconds?: number;
      reportPath?: string;
      markdown?: string;
      html?: string;
      detail?: string;
    };

export interface RunOptions {
  home: string;
  /** Consent prompt injector (tests); default = TTY prompt, non-TTY ⇒ refuse. */
  consentPrompt?: (info: { destination: string; preview: string }) => Promise<boolean>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Environment map for endpoint resolution (tests inject; default process.env). */
  env?: Record<string, string | undefined>;
  /** Injectable stderr progress reporter (wired by main; tests capture events). */
  progress?: ProgressReporter;
}

interface ParsedArgs {
  preview: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  days?: number;
  endpoint?: string;
  codexDir?: string;
  piDir?: string;
  now?: string;
  reportsDir?: string;
}

function nextValue(args: string[], index: number): string | undefined {
  return args[index];
}

class CliArgsError extends Error {}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    preview: false,
    json: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--preview":
        parsed.preview = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-V":
        parsed.version = true;
        break;
      case "--days": {
        const value = nextValue(args, ++i);
        if (value === undefined) {
          throw new CliArgsError("--days requires a number of days");
        }
        const days = Number(value);
        if (!Number.isInteger(days) || days <= 0) {
          throw new CliArgsError(`--days requires a positive integer, got: ${value}`);
        }
        parsed.days = days;
        break;
      }
      case "--endpoint": {
        const value = nextValue(args, ++i);
        if (value === undefined) {
          throw new CliArgsError("--endpoint requires a value");
        }
        // Full URL validation happens in resolveEndpoint (single source of
        // truth); here we only capture the raw value so an invalid scheme is
        // reported by the distinct invalid-endpoint diagnostic, not silently.
        parsed.endpoint = value;
        break;
      }
      case "--codex-dir": {
        const value = nextValue(args, ++i);
        if (value === undefined) {
          throw new CliArgsError("--codex-dir requires a directory");
        }
        parsed.codexDir = value;
        break;
      }
      case "--pi-dir": {
        const value = nextValue(args, ++i);
        if (value === undefined) {
          throw new CliArgsError("--pi-dir requires a directory");
        }
        parsed.piDir = value;
        break;
      }
      case "--now": {
        const value = nextValue(args, ++i);
        if (value === undefined || Number.isNaN(Date.parse(value))) {
          throw new CliArgsError("--now requires an ISO-8601 timestamp");
        }
        parsed.now = value;
        break;
      }
      case "--reports-dir": {
        const value = nextValue(args, ++i);
        if (value === undefined) {
          throw new CliArgsError("--reports-dir requires a directory");
        }
        parsed.reportsDir = value;
        break;
      }
      default:
        // Strict flags: unknown flags are rejected (root CLI review), never
        // silently ignored (an ignored flag could bypass consent/network
        // expectations).
        throw new CliArgsError(`unknown flag: ${arg} (see ryf --help)`);
    }
  }
  return parsed;
}

function reportTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-");
}

/**
 * CLI-side response guard (defense in depth; the backend validates provider
 * results too). Returns the validated AnalyzeResponse or undefined when the
 * response is malformed — a malformed response NEVER renders a complete
 * report.
 */
function validateResponseShape(body: unknown): AnalyzeResponse | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const b = body as Partial<AnalyzeResponse> & { error?: unknown };
  if (b.schema !== "analysis@1" || b.outcome !== "complete") {
    return undefined;
  }
  if (!Array.isArray(b.dimensions) || b.dimensions.length !== 5) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const dimension of b.dimensions) {
    if (typeof dimension !== "object" || dimension === null) {
      return undefined;
    }
    const d = dimension as AnalyzeResponse["dimensions"][number];
    if (typeof d.dimension !== "string" || seen.has(d.dimension)) {
      return undefined;
    }
    seen.add(d.dimension);
    if (
      typeof d.evaluable !== "boolean" ||
      !Array.isArray(d.evidence) ||
      typeof d.notes !== "string"
    ) {
      return undefined;
    }
    if (d.evaluable) {
      if (
        typeof d.score !== "number" ||
        !Number.isFinite(d.score) ||
        d.score < 0 ||
        d.score > 100
      ) {
        return undefined;
      }
    } else if (d.score !== undefined) {
      return undefined; // not-evaluable must never carry a fabricated score
    }
    for (const ref of d.evidence) {
      if (
        typeof ref !== "object" ||
        ref === null ||
        typeof (ref as { sessionId?: unknown }).sessionId !== "string" ||
        typeof (ref as { line?: unknown }).line !== "number"
      ) {
        return undefined;
      }
    }
  }
  const response: AnalyzeResponse = {
    schema: "analysis@1",
    outcome: "complete",
    dimensions: b.dimensions as AnalyzeResponse["dimensions"],
    confidenceNote: typeof b.confidenceNote === "string" ? b.confidenceNote : "",
  };
  if (typeof b.total === "number" && Number.isFinite(b.total)) {
    // Total consistency: all five evaluable ⇒ total is their weighted mean.
    const allEvaluable = response.dimensions.every((d) => d.evaluable);
    if (allEvaluable) {
      const mean = response.dimensions.reduce((sum, d) => sum + (d.score ?? 0), 0) / 5;
      if (Math.abs(mean - b.total) > 0.11) {
        return undefined; // inconsistent total
      }
      response.total = b.total;
    }
    // If not all evaluable, a total must NOT be present.
    else {
      return undefined;
    }
  } else if (b.total !== undefined) {
    return undefined;
  }
  return response;
}

    /**
     * Options for the default interactive consent prompt (test seam for 1.10).
     * The author reads the y/N answer from stdin; the printed preview/prompt moves
     * streams (see createDefaultConsentPrompt).
     */
    export interface DefaultConsentPromptOptions {
      /** Read the author's y/N answer (default process.stdin). */
      stdin?: NodeJS.ReadableStream;
      /** Reserved: the consent interaction must NEVER write to STDOUT (tests assert purity). */
      stdout?: NodeJS.WritableStream;
      /** The preview + prompt text (default process.stderr). */
      stderr?: NodeJS.WritableStream;
      /** In-progress stderr progress reporter to suspend before showing the prompt. */
      progress?: ProgressReporter;
    }

    /**
     * Build the default interactive consent prompt. Wired ONLY when the author is on
     * an interactive stdin and no prompt was injected. Returns true only for y/yes;
     * every other answer (including refusal) returns false.
     */
    export function createDefaultConsentPrompt(
      opts: DefaultConsentPromptOptions = {},
    ): (info: { destination: string; preview: string }) => Promise<boolean> {
      const stdin = opts.stdin ?? process.stdin;
      const stderr = opts.stderr ?? process.stderr;
      return async (info: { destination: string; preview: string }): Promise<boolean> => {
        // Suspend/clear the in-progress stderr progress line so the prompt lands on
        // its own clean line (never appended onto a live bar/spinner). Active progress
        // resumes through the caller's next reporter emission (the async backend-wait
        // spinner) after the answer.
        opts.progress?.waitingDone();
        // The preview + readline prompt go to STDERR, never STDOUT, so a first-use
        // --json run keeps STDOUT pure. The line-editor echo (typed chars/cursor
        // redraws) also goes to STDERR for the same reason; only the stdin answer is
        // read.
        stderr.write(
          `ryf will send a redacted digest to ${info.destination}.\nPreview:\n${info.preview}\nConsent? [y/N] `,
        );
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: stdin, output: stderr });
        const answer = (await rl.question("")).trim().toLowerCase();
        rl.close();
        return answer === "y" || answer === "yes";
      };
    }

    /** Run the ryf pipeline with the given arguments. */
    export async function runRyf(args: string[], options: RunOptions): Promise<RunResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return { mode: "error", message: error instanceof Error ? error.message : String(error) };
  }
  // Early exits BEFORE any consent/network (root CLI review).
  if (parsed.help) {
    return { mode: "help", usage: USAGE };
  }
  if (parsed.version) {
    return { mode: "version", version: VERSION };
  }

  const home = options.home;
  // Resolve the reports dir absolute so the printed/returned report path is
  // always absolute, even for a relative --reports-dir.
  const reportsDir =
    parsed.reportsDir === undefined ? join(home, ".ryf", "reports") : resolve(parsed.reportsDir);
  const started = Date.now();

  // 1. Discover + windowed metrics (record timestamps; mtime hint only).
  //    Discovery defaults derive from the PASSED home (never the real user
  //    HOME when a test injects one).
  const metricsOptions: Parameters<typeof computeLocalMetrics>[0] = {
    includeSessions: true,
    home,
    ...(parsed.days !== undefined ? { windowDays: parsed.days } : {}),
  };
  if (parsed.codexDir !== undefined) {
    metricsOptions.codexDir = parsed.codexDir;
  }
  if (parsed.piDir !== undefined) {
    metricsOptions.piDir = parsed.piDir;
  }
  if (parsed.now !== undefined) {
    metricsOptions.now = parsed.now;
  }
  const progress = options.progress;
  // Immediate first milestone BEFORE the metrics loop (the user must see
  // feedback within the first moments, not after the parse/build); preview
  // stays fully silent.
  if (progress !== undefined && !parsed.preview) {
    progress.stage("Reading sessions…");
  }
  // Per-file parser progress rides on the metrics pass; preview stays silent.
  if (progress !== undefined && !parsed.preview) {
    metricsOptions.onProgress = (processed, total) => progress.onProgress(processed, total);
  }
  const metrics = await computeLocalMetrics(metricsOptions);
  // "Preparing analysis" is emitted BEFORE the synchronous digest build; the
  // reporter MUST NOT animate a timer/fraction it cannot update (the event
  // loop is blocked here). Preview stays fully silent.
  if (progress !== undefined && !parsed.preview) {
    progress.stage("Preparing analysis");
  }
  const digest = buildDigest({
    sessions: metrics.parsedSessions ?? [],
    coverage: metrics.coverage,
  });

  // 2. Preview: send-free, no consent, no egress.
  if (parsed.preview) {
    return { mode: "preview", preview: renderPreview(digest) };
  }

  // 3. Endpoint resolution with explicit precedence (flag > env > config >
  //    consented destination > none). Missing configuration and invalid endpoints are
  //    distinct diagnostics, never conflated with `endpoint_unreachable`
  //    (a runtime connection failure) and never a fabricated default.
  const env = options.env ?? process.env;
  const resolution = resolveEndpoint(parsed.endpoint, env, home);
  if (resolution.kind === "missing") {
    const ts = reportTimestamp();
    const input = {
      errorCode: resolution.code,
      metrics,
      durationMs: Date.now() - started,
      timestamp: ts,
    };
    const markdown = renderIncompleteReport(input);
    const html = renderIncompleteHtml(input);
    const reportPath = saveReport(reportsDir, ts, html);
    return {
      mode: "incomplete",
      errorCode: resolution.code,
      detail: MISSING_ENDPOINT_DIAGNOSTIC,
      reportPath,
      markdown,
      html,
    };
  }
  if (resolution.kind === "invalid") {
    const ts = reportTimestamp();
    const input = {
      errorCode: resolution.code,
      metrics,
      durationMs: Date.now() - started,
      timestamp: ts,
    };
    const markdown = renderIncompleteReport(input);
    const html = renderIncompleteHtml(input);
    const reportPath = saveReport(reportsDir, ts, html);
    return {
      mode: "incomplete",
      errorCode: resolution.code,
      detail: `${INVALID_ENDPOINT_DIAGNOSTIC} (${resolution.reason})`,
      reportPath,
      markdown,
      html,
    };
  }
  if (resolution.kind === "config-invalid") {
    const ts = reportTimestamp();
    const input = {
      errorCode: resolution.code,
      metrics,
      durationMs: Date.now() - started,
      timestamp: ts,
    };
    const markdown = renderIncompleteReport(input);
    const html = renderIncompleteHtml(input);
    const reportPath = saveReport(reportsDir, ts, html);
    return {
      mode: "incomplete",
      errorCode: resolution.code,
      detail: `${CLIENT_CONFIG_DIAGNOSTIC} (${resolution.reason})`,
      reportPath,
      markdown,
      html,
    };
  }
  const endpoint = resolution.endpoint;

  // 4. Consent gate (destination = the consent-bound dev endpoint).
  if (shouldRePrompt(home, endpoint)) {
    const prompt =
      options.consentPrompt ??
      (process.stdin.isTTY
        ? createDefaultConsentPrompt(progress !== undefined ? { progress } : {})
        : async () => false); // non-interactive without injector: refuse (no egress)
    const granted = await prompt({ destination: endpoint, preview: renderPreview(digest) });
    const record: ConsentRecord = {
      version: "consent@1",
      state: granted ? "consented" : "refused",
      destination: endpoint,
      scopeVersion: 1,
      timestamp: new Date().toISOString(),
    };
    saveConsent(home, record);
    if (!granted) {
      const ts = reportTimestamp();
      const input = {
        errorCode: "consent_refused",
        metrics,
        durationMs: Date.now() - started,
        timestamp: ts,
      };
      const markdown = renderIncompleteReport(input);
      const html = renderIncompleteHtml(input);
      const reportPath = saveReport(reportsDir, ts, html);
      return { mode: "incomplete", errorCode: "consent_refused", reportPath, markdown, html };
    }
  }

  // 5. Add the configured CA only for its configured endpoint, immediately
  // before the request. This preserves normal verification and existing roots.
  let restoreTrust: () => void;
  try {
    restoreTrust = configureEndpointTrust(resolution.clientConfig, endpoint);
  } catch (error) {
    const ts = reportTimestamp();
    const input = {
      errorCode: CLIENT_CA_INVALID_CODE,
      metrics,
      durationMs: Date.now() - started,
      timestamp: ts,
    };
    const markdown = renderIncompleteReport(input);
    const html = renderIncompleteHtml(input);
    const reportPath = saveReport(reportsDir, ts, html);
    return {
      mode: "incomplete",
      errorCode: CLIENT_CA_INVALID_CODE,
      detail: error instanceof Error ? error.message : `${CLIENT_CA_INVALID_CODE}: invalid client CA configuration`,
      reportPath,
      markdown,
      html,
    };
  }

  // 6. Analyze (single egress; redirects refused inside the client).
  const installUUID = getOrCreateInstallUUID(home);
  const postOptions: { timeoutMs: number; fetchImpl?: typeof fetch } = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  if (options.fetchImpl !== undefined) {
    postOptions.fetchImpl = options.fetchImpl;
  }
  // Semantic-wait: the reporter names the endpoint and shows elapsed time
  // while the backend request is in flight; the spinner stops in a finally
  // so it never dangles on any outcome.
  progress?.waitingFor(endpoint);
  const analysis: AnalysisResult = await postAnalysis(
    endpoint,
    digest,
    installUUID,
    postOptions,
  ).finally(() => {
    restoreTrust();
    progress?.waitingDone();
  });
  const durationMs = Date.now() - started;

  if (analysis.ok) {
    // analysis@1 200-with-incomplete envelope (root E2E review): preserve the
    // backend's error code + retry-after instead of flattening to
    // invalid_model_response. Allowed codes only; retryAfter finite >= 0.
    const bodyForIncomplete = analysis.body as {
      outcome?: unknown;
      error?: { code?: unknown; retryAfterSeconds?: unknown };
    };
    if (
      (bodyForIncomplete as { outcome?: unknown } | null)?.outcome === "incomplete" &&
      typeof bodyForIncomplete.error?.code === "string" &&
      ANALYSIS_ERROR_CODES.includes(bodyForIncomplete.error.code as never)
    ) {
      const retryRaw = bodyForIncomplete.error.retryAfterSeconds;
      const retryValid =
        typeof retryRaw === "number" && Number.isFinite(retryRaw) && retryRaw >= 0
          ? retryRaw
          : undefined;
      const ts = reportTimestamp();
      const input = {
        errorCode: bodyForIncomplete.error.code,
        ...(retryValid !== undefined ? { retryAfterSeconds: retryValid } : {}),
        metrics,
        durationMs,
        timestamp: ts,
      };
      const markdown = renderIncompleteReport(input);
      const html = renderIncompleteHtml(input);
      const reportPath = saveReport(reportsDir, ts, html);
      return {
        mode: "incomplete",
        errorCode: bodyForIncomplete.error.code,
        ...(retryValid !== undefined ? { retryAfterSeconds: retryValid } : {}),
        reportPath,
        markdown,
        html,
      };
    }
    // CLI-side response guard: malformed backend responses NEVER render a
    // complete report (root CLI review).
    const validated = validateResponseShape(analysis.body);
    if (validated !== undefined) {
      const digestCoverage = {
        samplingSelected: Number(digest.counters["samplingSelected"] ?? 0),
        samplingOmitted: Number(digest.counters["samplingOmitted"] ?? 0),
      };
      const ts = reportTimestamp();
      const input = {
        response: validated,
        metrics,
        digestCoverage,
        durationMs,
        timestamp: ts,
      };
      const markdown = renderCompleteReport(input);
      const html = renderCompleteHtml(input);
      const reportPath = saveReport(reportsDir, ts, html);
      const result: RunResult = {
        mode: "complete",
        reportPath,
        markdown,
        html,
        digestCoverage,
        ...(validated.total !== undefined ? { total: validated.total } : {}),
      };
      return result;
    }
    const ts = reportTimestamp();
    const input = {
      errorCode: "invalid_model_response",
      metrics,
      durationMs,
      timestamp: ts,
    };
    const markdown = renderIncompleteReport(input);
    const html = renderIncompleteHtml(input);
    const reportPath = saveReport(reportsDir, ts, html);
    return { mode: "incomplete", errorCode: "invalid_model_response", reportPath, markdown, html };
  }

  // 6. Honest failure: incomplete report with the real error code.
  const ts = reportTimestamp();
  const input = {
    errorCode: analysis.error.code,
    ...(analysis.error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: analysis.error.retryAfterSeconds }
      : {}),
    metrics,
    durationMs,
    timestamp: ts,
  };
  const markdown = renderIncompleteReport(input);
  const html = renderIncompleteHtml(input);
  const reportPath = saveReport(reportsDir, ts, html);
  return {
    mode: "incomplete",
    errorCode: analysis.error.code,
    ...(analysis.error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: analysis.error.retryAfterSeconds }
      : {}),
    reportPath,
    markdown,
    html,
  };
}

/** CLI main: parse args, run, print, exit. */
export async function main(argv: string[]): Promise<number> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const json = argv.includes("--json");
  // Preview/help/version are silent (no lifecycle progress); every other
  // mode wires a stderr reporter so stdout stays machine-readable.
  const quiet =
    argv.includes("--preview") ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv.includes("--version") ||
    argv.includes("-V");
  const reporter = quiet
    ? undefined
    : createProgressReporter({ stream: process.stderr, wireSignals: isDirectRun });
  const runOptions: RunOptions = { home };
  if (reporter !== undefined) {
    runOptions.progress = reporter;
  }

  let result: RunResult;
  try {
    result = await runRyf(
      argv.filter((a) => a !== "--json"),
      runOptions,
    );
  } catch (error) {
    // Any thrown error (parser, digest build, fs write) must still remove
    // the active line and signal listeners, then propagate to the caller.
    reporter?.abort();
    throw error;
  }

  // ORDER: clean up the reporter BEFORE any final stdout/stderr emission so
  // the final path/diagnostic lands on its own line — never appended onto a
  // still-active progress line (which abort() would then erase).
  if (reporter !== undefined) {
    if (result.mode === "complete") {
      reporter.finish();
    } else {
      reporter.abort();
    }
  }

  let reportUrl: string | undefined;
  if (result.mode === "complete") {
    reportUrl = pathToFileURL(result.reportPath).href;
  } else if (result.mode === "incomplete" && result.reportPath !== undefined) {
    reportUrl = pathToFileURL(result.reportPath).href;
  }

  try {
    if (json && result.mode !== "preview") {
      const jsonResult = reportUrl === undefined ? result : { ...result, reportUrl };
      process.stdout.write(
        `${JSON.stringify(jsonResult, (_key, value) => (value === undefined ? undefined : value), 2)}\n`,
      );
    } else if (result.mode === "preview") {
      process.stdout.write(`${result.preview}\n`);
    } else if (result.mode === "help") {
      process.stdout.write(result.usage);
    } else if (result.mode === "version") {
      process.stdout.write(`${result.version}\n`);
    } else if (result.mode === "error") {
      process.stderr.write(`ryf: ${result.message}\nUsage: ryf --help\n`);
    } else {
      // Report-writing modes (complete/incomplete): the report is saved as a
      // local .html file; print its absolute path, never the report body.
      process.stdout.write(`${result.reportPath}\n`);
    }
    if (reportUrl !== undefined) {
      process.stderr.write(`Report: ${reportUrl}\n`);
    }
    if (result.mode === "incomplete" && result.detail !== undefined) {
      // Human-readable diagnostic followed by the stable machine token so
      // operators/scripts can grep/match the failure type without parsing
      // prose. The human message is preserved verbatim above the token.
      process.stderr.write(
        `ryf: ${result.detail}${result.errorCode !== undefined ? ` (${result.errorCode})` : ""}\n`,
      );
    }
  } catch (error) {
    reporter?.abort();
    throw error;
  }
  return result.mode === "incomplete" || result.mode === "error" ? 1 : 0;
}

// Direct-run guard that works through the INSTALLED SYMLINK: resolve the
// invoked path's realpath and compare with this module's realpath (root CLI
// review: argv[1] is <prefix>/bin/ryf when installed, never .../bin.js).
import { realpathSync } from "node:fs";
const isDirectRun = ((): boolean => {
  try {
    const invoked = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : undefined;
    if (invoked === undefined) {
      return false;
    }
    return invoked === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(
        `ryf failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
