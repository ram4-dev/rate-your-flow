/**
 * digest@1 builder (Phase 4, tasks 4.1–4.4 + U3 root-review remediations).
 *
 * - Versioned schema `digest@1` (contract in src/shared/contracts/digest@1.ts).
 * - Shipped default budget 48 KiB UTF-8 (DIGEST_DEFAULT_BUDGET_BYTES),
 *   operator-overridable, never unconfigured.
 * - Deterministic sampling: at most DIGEST_MAX_SESSIONS (50) sessions chosen
 *   by most recent activity timestamp; unknown timestamps sort after valid
 *   ones and session IDs break ties. Coverage counters are RECOMPUTED after
 *   sampling (samplingSelected / samplingOmitted).
 * - Redact BEFORE clip (root review fix 2): full source text is redacted
 *   first, then clipped — a credential straddling the snippet boundary can
 *   never leak a partial pattern.
 * - Message extraction (root review fix 1): codex content ARRAYS (content
 *   parts joined), pi top-level message payloads, and tool outputs are all
 *   extracted (bounded), so real digests carry prompts/responses/tool results.
 * - Hard budget (root review fix 3): deterministic bounded sampling of
 *   episodes and events preserves useful snippets; an explicit typed error is
 *   thrown when even the minimal envelope cannot fit — never a silent
 *   over-budget digest.
 * - No full raw traces: snippet text hard-bounded (≤160 chars), derived only
 *   from message content / tool names / tool outputs.
 */

import {
  DIGEST_DEFAULT_BUDGET_BYTES,
  DIGEST_MAX_SESSIONS,
  DIGEST_SCHEMA,
  type CitedSnippet,
  type DigestEpisode,
  type DigestEvent,
  type DigestEventSequence,
  type DigestV1,
} from "../shared/contracts/digest@1.js";
import { redact } from "../shared/redact.js";
import type { Session } from "./parsers/model.js";
import { toEpochMs } from "./parsers/timestamps.js";

/** Thrown when the minimal digest envelope cannot fit the configured budget. */
export class DigestBudgetError extends Error {
  constructor(budgetBytes: number) {
    super(
      `digest minimal envelope cannot fit within the configured budget of ${budgetBytes} bytes; ` +
        "increase the budget (the default is 48 KiB)",
    );
    this.name = "DigestBudgetError";
  }
}

/** Latest-session selection: valid activity timestamps first, descending and deterministic. */
function latestSelection(sessions: Session[], max: number): Session[] {
  return [...sessions]
    .sort((a, b) => {
      const aMs = toEpochMs(a.latestRecordTimestamp);
      const bMs = toEpochMs(b.latestRecordTimestamp);
      if (aMs !== undefined && bMs !== undefined && aMs !== bMs) {
        return bMs - aMs;
      }
      if (aMs !== undefined && bMs === undefined) return -1;
      if (aMs === undefined && bMs !== undefined) return 1;
      if (a.sessionId === b.sessionId) return 0;
      return a.sessionId < b.sessionId ? -1 : 1;
    })
    .slice(0, max);
}

const SNIPPET_MAX_CHARS = 160;

/** Extract a bounded text from a record payload (message content, tool I/O). */
function extractSnippetText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const p = payload as {
    type?: string;
    role?: string;
    content?: unknown;
    name?: unknown;
    output?: unknown;
    arguments?: unknown;
  };

  // Message content: string OR array of parts ({type,text} | string).
  if (p.type === "message") {
    const parts: string[] = [];
    if (typeof p.content === "string") {
      parts.push(`${String(p.role ?? "message")}: ${p.content}`);
    } else if (Array.isArray(p.content)) {
      const joined = p.content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (
            typeof part === "object" &&
            part !== null &&
            "text" in (part as Record<string, unknown>)
          ) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .filter((text) => text !== "")
        .join(" ");
      if (joined !== "") {
        parts.push(`${String(p.role ?? "message")}: ${joined}`);
      }
    }
    if (parts.length > 0) {
      return parts.join(" | ");
    }
    return undefined;
  }

  // Tool calls: name (arguments intentionally not included — may embed secrets).
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    return `tool call ${String(p.name ?? "")}`;
  }

  // Tool outputs: surfaced (bounded) — real signals for the semantic pass.
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    if (typeof p.output === "string" && p.output.trim() !== "") {
      return `tool output: ${p.output}`;
    }
  }
  return undefined;
}

function snippetTextFor(payload: unknown): string | undefined {
  const raw = extractSnippetText(payload);
  if (raw === undefined) {
    return undefined;
  }
  // REDACT FIRST on the FULL text, THEN clip (root review fix 2). A secret
  // straddling the clip boundary is erased before any truncation, so no
  // partial pattern can leak.
  const redacted = redact(raw);
  return redacted.length > SNIPPET_MAX_CHARS
    ? `${redacted.slice(0, SNIPPET_MAX_CHARS - 1)}…`
    : redacted;
}

export interface DigestInput {
  sessions: Session[];
  coverage: { eligible: number; analyzed: number; omitted: number };
}

export interface DigestOptions {
  /** Size budget in UTF-8 bytes (default DIGEST_DEFAULT_BUDGET_BYTES). */
  budgetBytes?: number;
  /** Sampling cap (default DIGEST_MAX_SESSIONS). */
  maxSessions?: number;
}

/** Build the budget-bounded, redacted digest@1 (deterministic). */
export function buildDigest(input: DigestInput, options: DigestOptions = {}): DigestV1 {
  const budget = options.budgetBytes ?? DIGEST_DEFAULT_BUDGET_BYTES;
  const maxSessions = options.maxSessions ?? DIGEST_MAX_SESSIONS;

  const selected = latestSelection(input.sessions, maxSessions);
  const sorted = [...selected].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

  const eventSequences: DigestEventSequence[] = [];
  const episodes: DigestEpisode[] = [];
  const citedSnippets: CitedSnippet[] = [];

  let toolCallsTotal = 0;
  let toolCallsResolved = 0;

  for (const session of sorted) {
    const events: DigestEvent[] = [];
    for (const record of session.records) {
      const event: DigestEvent = { line: record.line, kind: record.type };
      if (record.timestamp !== undefined) {
        event.ts = record.timestamp;
      }
      events.push(event);
      const text = snippetTextFor(record.payload);
      if (text !== undefined) {
        citedSnippets.push({ sessionId: session.sessionId, line: record.line, text });
      }
    }
    eventSequences.push({ sessionId: session.sessionId, events });

    for (const episode of session.episodes) {
      const startLine = episode.lineRefs[0] ?? 0;
      const endLine = episode.lineRefs[episode.lineRefs.length - 1] ?? startLine;
      episodes.push({
        sessionId: session.sessionId,
        startLine,
        endLine,
        summary: `episode with ${episode.events.length} event(s)`,
      });
    }

    toolCallsTotal += session.toolCalls.length;
    toolCallsResolved += session.toolCalls.filter((call) => call.resolved).length;
  }

  // Coverage recomputed AFTER sampling (root review fix 3).
  const samplingSelected = sorted.length;
  const samplingOmitted = input.coverage.analyzed - samplingSelected;

  const digest: DigestV1 = {
    schema: DIGEST_SCHEMA,
    counters: {
      sessions: samplingSelected,
      coverageEligible: input.coverage.eligible,
      coverageAnalyzed: input.coverage.analyzed,
      coverageOmitted: input.coverage.omitted,
      samplingSelected,
      samplingOmitted,
      episodes: episodes.length,
      toolCalls: toolCallsTotal,
      toolCallsResolved,
      sources: new Set(sorted.map((session) => session.source)).size,
    },
    eventSequences,
    episodes,
    citedSnippets,
  };

  // Hard budget, deterministic tiers — snippets retained as long as possible
  // (they carry the semantic evidence); metadata compacts first.
  const size = (): number => Buffer.byteLength(JSON.stringify(digest), "utf8");
  const trimSnippets = (): void => {
    while (size() > budget && digest.citedSnippets.length > 0) {
      digest.citedSnippets.pop();
    }
  };

  // Tier 1: compact event sequences to first+last event per session.
  while (size() > budget) {
    const before = JSON.stringify(digest.eventSequences);
    digest.eventSequences = digest.eventSequences.map((sequence) => {
      if (sequence.events.length <= 2) {
        return sequence;
      }
      return {
        ...sequence,
        events: [
          sequence.events[0] as DigestEvent,
          sequence.events[sequence.events.length - 1] as DigestEvent,
        ],
      };
    });
    if (JSON.stringify(digest.eventSequences) === before) {
      break;
    }
  }
  // Tier 2: strip ts fields from events (line+kind anchors kept).
  while (size() > budget) {
    const before = JSON.stringify(digest.eventSequences);
    digest.eventSequences = digest.eventSequences.map((sequence) => ({
      ...sequence,
      events: sequence.events.map((event) => ({ line: event.line, kind: event.kind })),
    }));
    if (JSON.stringify(digest.eventSequences) === before) {
      break;
    }
  }
  // Tier 3: bounded EPISODE sampling — keep an even, deterministic subset of
  // episodes (at most one per kept boundary, spread across sessions) while
  // snippets remain intact.
  while (size() > budget && digest.episodes.length > 0) {
    const before = JSON.stringify(digest.episodes);
    const keep = Math.max(1, Math.floor(digest.episodes.length / 2));
    const stride = digest.episodes.length / keep;
    const sampled: DigestEpisode[] = [];
    for (let k = 0; k < keep; k++) {
      sampled.push(digest.episodes[Math.floor(k * stride)] as DigestEpisode);
    }
    digest.episodes = sampled;
    if (JSON.stringify(digest.episodes) === before) {
      break;
    }
  }
  // Tier 4 (last resort): trim cited snippets from the tail.
  trimSnippets();
  // If even the minimal envelope (counters + compacted anchors) cannot fit,
  // fail loudly — never emit a silent over-budget digest.
  if (size() > budget) {
    throw new DigestBudgetError(budget);
  }
  return digest;
}

/**
 * Render the digest exactly as it would be sent (stable key order via
 * JSON.stringify on the fixed field order) — preview === payload.
 */
export function renderPreview(digest: DigestV1): string {
  return JSON.stringify(digest);
}
