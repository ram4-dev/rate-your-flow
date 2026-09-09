/**
 * codex@1 session parser — JSONL line loop over a Codex session file.
 *
 * Strictly read-only: the source file is opened for reading only and its
 * bytes are never modified.
 *
 * Robustness (U2c): a malformed line is skipped, counted, and warned with a
 * fixed English phrase — raw line content is NEVER embedded in warnings or
 * errors (privacy requirement). A truncated trailing record is reported and
 * excluded from inference. Active sessions parse safely (no terminal event
 * required). An empty file yields a defined empty session.
 *
 * Real-format fidelity (11-parser-review P1/P3/P4/P5):
 * - token_usage_record payload carries NESTED usage/thread_token_usage/
 *   turn_token_usage fields (real shape); separate top-level thread/turn
 *   record types are legacy (0 occurrences in the corpus) and are parsed but
 *   flagged `legacyShape` (never verified).
 * - function_call/function_call_output carry NO error/isError/status field:
 *   ToolCall.isError stays undefined for codex (undetectable), and a fixed
 *   session warning records that limitation so metrics stay honest.
 * - custom_tool_call/custom_tool_call_output correlate like function_call*.
 * - role "developer" appends to the current episode (not a binary world).
 */

import { readFile } from "node:fs/promises";
import type {
  Episode,
  ParsedRecord,
  ParseWarning,
  Session,
  SourceVersion,
  ToolCall,
  TokenEvent,
} from "./model.js";
import { maxTimestampByInstant } from "./timestamps.js";

const SOURCE = "codex";
const SOURCE_VERSION: SourceVersion = "codex@1";
const EPISODE_BRANCH_ID = "main";

interface TokenCounts {
  [key: string]: number;
}

function numericCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof value === "object" && value !== null) {
    for (const [key, count] of Object.entries(value as TokenCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        counts[key] = count;
      }
    }
  }
  return counts;
}

export async function parseCodexSession(filePath: string): Promise<Session> {
  const text = await readFile(filePath, "utf8");
  const warnings: ParseWarning[] = [];
  const records: ParsedRecord[] = [];
  const episodes: Episode[] = [];
  const toolCalls: ToolCall[] = [];
  const tokenEvents: TokenEvent[] = [];
  let invalidLineCount = 0;
  let sessionId = "";
  let latestRecordTimestamp: string | undefined;
  let sawToolCalls = false;

  let currentEpisode: Episode | undefined;

  const startOrCurrentEpisode = (): Episode => {
    if (currentEpisode === undefined) {
      currentEpisode = { branchId: EPISODE_BRANCH_ID, events: [], lineRefs: [] };
      episodes.push(currentEpisode);
    }
    return currentEpisode;
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw === undefined || raw.trim() === "") {
      continue; // blank separator / trailing newline
    }
    const line = index + 1;
    let record: { type?: unknown; timestamp?: unknown; payload?: unknown };
    try {
      record = JSON.parse(raw) as { type?: unknown; timestamp?: unknown; payload?: unknown };
    } catch {
      // Skip + count + warn. The warning NEVER embeds raw line content.
      invalidLineCount += 1;
      warnings.push({ line, message: "invalid JSON line skipped" });
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "";
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    latestRecordTimestamp = maxTimestampByInstant(latestRecordTimestamp, record.timestamp);

    const parsed: ParsedRecord =
      timestamp === undefined
        ? { line, type, payload: record.payload }
        : { line, type, timestamp, payload: record.payload };
    records.push(parsed);

    switch (type) {
      case "session_meta": {
        const payload = record.payload as { id?: unknown } | undefined;
        if (typeof payload?.id === "string") {
          sessionId = payload.id;
        }
        break;
      }
      case "response_item": {
        const payload = (record.payload ?? {}) as {
          type?: string;
          role?: string;
          call_id?: unknown;
          name?: unknown;
        };
        // P4: custom_tool_call correlates exactly like function_call (same
        // call_id/output convention; name from payload.name).
        const isCall =
          (payload.type === "function_call" || payload.type === "custom_tool_call") &&
          typeof payload.call_id === "string";
        const isOutput =
          (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
          typeof payload.call_id === "string";
        if (isCall) {
          sawToolCalls = true;
          toolCalls.push({
            callId: payload.call_id as string,
            name: typeof payload.name === "string" ? payload.name : "",
            resolved: false,
          });
        } else if (isOutput) {
          const callId = payload.call_id as string;
          const call = toolCalls.find((candidate) => candidate.callId === callId);
          if (call !== undefined) {
            call.resolved = true;
          }
          // P3: real outputs carry no error flag; isError stays undefined for
          // codex (never fabricated).
        }
        // Episode grouping: each user message opens a new episode; every other
        // response_item (assistant/developer message, call, output) appends.
        if (payload.type === "message" && payload.role === "user") {
          currentEpisode = { branchId: EPISODE_BRANCH_ID, events: [], lineRefs: [] };
          episodes.push(currentEpisode);
        }
        startOrCurrentEpisode().events.push(parsed);
        startOrCurrentEpisode().lineRefs.push(line);
        break;
      }
      case "event_msg":
        break; // passthrough record only
      case "token_usage_record": {
        // P1: real shape — usage + NESTED thread_token_usage/turn_token_usage
        // inside the SAME record payload.
        const payload = (record.payload ?? {}) as {
          usage?: unknown;
          thread_token_usage?: unknown;
          turn_token_usage?: unknown;
        };
        const usage = numericCounts(payload.usage);
        if (Object.keys(usage).length > 0) {
          tokenEvents.push({ recordType: "usage", counts: usage, verified: false });
        }
        const thread = numericCounts(payload.thread_token_usage);
        if (Object.keys(thread).length > 0) {
          tokenEvents.push({
            recordType: "thread_token_usage",
            counts: thread,
            verified: false,
          });
        }
        const turn = numericCounts(payload.turn_token_usage);
        if (Object.keys(turn).length > 0) {
          tokenEvents.push({ recordType: "turn_token_usage", counts: turn, verified: false });
        }
        break;
      }
      case "thread_token_usage":
      case "turn_token_usage": {
        // P1: legacy separate top-level types — 0 occurrences in the real
        // corpus; parsed for forward compat but never verified.
        const counts = numericCounts(record.payload);
        if (Object.keys(counts).length > 0) {
          tokenEvents.push({
            recordType: type as TokenEvent["recordType"],
            counts,
            verified: false,
            legacyShape: true,
          });
        }
        break;
      }
      default:
        break; // unknown types pass through as records
    }
  }

  // Truncated file: a trailing partial record was skipped above; report it so
  // unrecoverable content is excluded from inference visibly.
  if (invalidLineCount > 0) {
    warnings.push({
      line: lines.length,
      message: `truncated/corrupted content: ${invalidLineCount} line(s) skipped and excluded from inference`,
    });
  }
  // P3 honesty: tool errors are undetectable in codex@1 (no error field in the
  // real format). Warn so downstream metrics/report never claim otherwise.
  if (sawToolCalls) {
    warnings.push({
      line: 0,
      message: "tool-errors-undetectable-in-codex@1",
    });
  }

  const result: Session = {
    source: SOURCE,
    sourceVersion: SOURCE_VERSION,
    sessionId,
    filePath,
    records,
    episodes,
    toolCalls,
    tokenEvents,
    warnings,
  };
  // exactOptionalPropertyTypes: only set when at least one record carries a timestamp.
  if (latestRecordTimestamp !== undefined) {
    result.latestRecordTimestamp = latestRecordTimestamp;
  }
  return result;
}
