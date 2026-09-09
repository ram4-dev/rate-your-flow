/**
 * Local metrics over the 90-day window (Phase 3, tasks 3.2/3.3).
 *
 * - Window filtering is by RECORD TIMESTAMPS only (instants via epoch ms):
 *   boundary is inclusive at exactly `windowDays` (default 90) and exclusive
 *   beyond. File mtime NEVER admits a session (parent ruling; discovery uses
 *   mtime as an ordering hint only).
 * - Fully offline: pure fs + pure functions, no network.
 * - Metrics are SUPPORTING EVIDENCE: they never replace or cap the model's
 *   semantic assessment. Token aggregates from the parser surface are carried
 *   with their unverified flags (honest counts-only).
 * - Coverage is surfaced as eligible/analyzed/omitted counts; no
 *   total-coverage percentage is asserted.
 */

import { discoverSessions } from "./discover.js";
import { getParserForSource } from "./parsers/registry.js";
import { summarizeTokenUsage, type TokenSummary } from "./parsers/token-gate.js";
import { toEpochMs } from "./parsers/timestamps.js";
import type { ParseWarning, Session } from "./parsers/model.js";

export interface SessionMetrics {
  sessionId: string;
  source: "codex" | "pi";
  sourceVersion: string;
  latestRecordTimestamp?: string;
  toolCalls: { total: number; resolved: number; unresolved: number; errored: number };
  episodeCount: number;
  /** Structured parser warnings (fixed phrases; never raw line content). */
  warnings: ParseWarning[];
  /** Honest counts-only token summary when the session carries token events. */
  tokenSummary?: TokenSummary;
}

export interface LocalMetrics {
  /** Supporting-evidence statement (never a semantic claim). */
  supportingEvidenceNote: string;
  coverage: { eligible: number; analyzed: number; omitted: number };
  sessions: SessionMetrics[];
  /** Raw parsed sessions when `includeSessions` was requested (digest build). */
  parsedSessions?: Session[];
}

export interface MetricsOptions {
  codexDir?: string;
  piDir?: string;
  /** HOME used for DEFAULT store roots when explicit dirs are absent. */
  home?: string;
  /** Reference "now" (ISO-8601). Defaults to the current instant. */
  now?: string;
  /** Window length in days (default 90). */
  windowDays?: number;
  /** Also return the parsed in-window sessions (CLI pipeline reuse). */
  includeSessions?: boolean;
  /**
   * Per-file parser progress callback (task 1.6): fired after EVERY file
   * including omitted/out-of-window and parser-failure paths, so the
   * reporter's session bar always advances to `total`.
   */
  onProgress?: (processed: number, total: number) => void;
}

/** Compute local supporting-evidence metrics (offline, read-only). */
export async function computeLocalMetrics(options: MetricsOptions): Promise<LocalMetrics> {
  const windowDays = options.windowDays ?? 90;
  const nowMs = options.now !== undefined ? toEpochMs(options.now) : Date.now();
  if (nowMs === undefined) {
    throw new Error("invalid reference now (must be an ISO-8601 instant)");
  }
  const boundaryMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const discoverOptions: { codexDir?: string; piDir?: string; home?: string } = {};
  if (options.codexDir !== undefined) {
    discoverOptions.codexDir = options.codexDir;
  }
  if (options.piDir !== undefined) {
    discoverOptions.piDir = options.piDir;
  }
  if (options.home !== undefined) {
    discoverOptions.home = options.home;
  }
  const discovered = await discoverSessions(discoverOptions);
  const eligible = discovered.length;

  const sessions: SessionMetrics[] = [];
  const inWindow: Session[] = [];
  let processed = 0;
  for (const entry of discovered) {
    let session: Session | undefined;
    try {
      session = await getParserForSource(entry.source)(entry.filePath);
    } catch {
      // Parser failure: this file contributes nothing, but progress still
      // advances past it (truthful bar; a single bad file must not stall).
      session = undefined;
    }
    // Window by the session's latest RECORD timestamp (instant comparison).
    const latestMs = session !== undefined ? toEpochMs(session.latestRecordTimestamp) : undefined;
    if (session !== undefined && latestMs !== undefined && latestMs >= boundaryMs) {
      const errored = session.toolCalls.filter((call) => call.isError === true).length;
      const resolved = session.toolCalls.filter((call) => call.resolved).length;
      const metrics: SessionMetrics = {
        sessionId: session.sessionId,
        source: entry.source,
        sourceVersion: session.sourceVersion,
        toolCalls: {
          total: session.toolCalls.length,
          resolved,
          unresolved: session.toolCalls.length - resolved,
          errored,
        },
        episodeCount: session.episodes.length,
        warnings: session.warnings,
      };
      if (session.latestRecordTimestamp !== undefined) {
        metrics.latestRecordTimestamp = session.latestRecordTimestamp;
      }
      if (session.tokenEvents.length > 0) {
        metrics.tokenSummary = summarizeTokenUsage(session);
      }
      sessions.push(metrics);
      if (options.includeSessions === true) {
        inWindow.push(session);
      }
    }
    processed += 1;
    options.onProgress?.(processed, discovered.length);
  }

  const result: LocalMetrics = {
    supportingEvidenceNote:
      "local metrics are supporting evidence only; they do not replace or cap the model's semantic assessment",
    coverage: { eligible, analyzed: sessions.length, omitted: eligible - sessions.length },
    sessions,
  };
  if (options.includeSessions === true) {
    result.parsedSessions = inWindow;
  }
  return result;
}
