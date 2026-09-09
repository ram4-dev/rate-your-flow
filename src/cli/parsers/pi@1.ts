/**
 * pi@1 session parser — id/parentId branch graph over JSONL lines.
 *
 * Episodes are emitted per branch via deterministic linearization
 * (branch-graph.ts, design D6): the primary path is the parent chain of the
 * last event; ordering is by first timestamp, tie by joined id path. Token
 * usage is per-message and attributed to exactly one episode (shared
 * ancestors are owned by the primary branch), so cross-branch token sums
 * never double-count. A source `version` field is read when present but never
 * assumed (no v3 behavioral special-casing anywhere in this parser).
 *
 * Strictly read-only. Robustness (invalid-line skip+count+warn, truncation,
 * active sessions) lands in U2c; a malformed line may currently throw,
 * matching the codex@1 parser until then.
 */

import { readFile } from "node:fs/promises";
import { assignTokenOwnership, buildBranches, type BranchNode } from "../branch-graph.js";
import type {
  Episode,
  ParsedRecord,
  ParseWarning,
  Session,
  SourceVersion,
  ToolCall,
  TokenEvent,
} from "./model.js";

const SOURCE = "pi";
const SOURCE_VERSION: SourceVersion = "pi@1";

/** Mirrors codex@1's numericCounts (shared helper deferred). */
function numericCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof value === "object" && value !== null) {
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        counts[key] = count;
      }
    }
  }
  return counts;
}

interface PiMessage {
  id?: unknown;
  parentId?: unknown;
  role?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  usage?: unknown;
}

export async function parsePiSession(filePath: string): Promise<Session> {
  const text = await readFile(filePath, "utf8");
  const warnings: ParseWarning[] = [];
  const records: ParsedRecord[] = [];
  const recordByLine = new Map<number, ParsedRecord>();
  const nodes: BranchNode[] = [];
  const toolCalls: ToolCall[] = [];
  const tokenEvents: TokenEvent[] = [];
  const usageMessageIds: string[] = [];
  let sessionId = "";
  let appVersion: string | undefined;
  let latestRecordTimestamp: string | undefined;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw === undefined || raw.trim() === "") {
      continue; // blank separator / trailing newline
    }
    const line = index + 1;
    const record = JSON.parse(raw) as Record<string, unknown>;
    const typeValue = record["type"];
    const type = typeof typeValue === "string" ? typeValue : "";
    const timestampValue = record["timestamp"];
    const timestamp = typeof timestampValue === "string" ? timestampValue : undefined;
    if (
      timestamp !== undefined &&
      (latestRecordTimestamp === undefined || timestamp > latestRecordTimestamp)
    ) {
      latestRecordTimestamp = timestamp;
    }

    const parsed: ParsedRecord =
      timestamp === undefined
        ? { line, type, payload: record }
        : { line, type, timestamp, payload: record };
    records.push(parsed);
    recordByLine.set(line, parsed);

    if (type === "session") {
      const id = record["id"];
      if (typeof id === "string") {
        sessionId = id;
      }
      // Version field: read when present, never assumed.
      const version = record["version"];
      if (typeof version === "string") {
        appVersion = version;
      }
      continue; // session record carries no id/parentId graph membership
    }

    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    const parentIdValue = record["parentId"];
    const parentId =
      parentIdValue === null || typeof parentIdValue === "string" ? parentIdValue : undefined;
    if (id === undefined || parentId === undefined) {
      continue; // records without graph membership pass through as records only
    }
    const node: BranchNode = { id, parentId: parentId === null ? null : parentId, line };
    if (timestamp !== undefined) {
      node.timestamp = timestamp;
    }
    nodes.push(node);

    // Token usage: per-message, attributed to this message id for exclusive
    // branch ownership (no double counting across branches).
    const usage = numericCounts((record as PiMessage).usage);
    if (Object.keys(usage).length > 0) {
      tokenEvents.push({ recordType: "usage", counts: usage, verified: false, sourceId: id });
      usageMessageIds.push(id);
    }

    // Tool correlation: a message with toolCallId+toolName is a call; one with
    // only a toolCallId is its result. isError=true marks ToolCall.isError;
    // repeated toolName + similar args (polling) is a fresh call, never an error.
    const toolCallId = (record as PiMessage).toolCallId;
    if (typeof toolCallId === "string") {
      const toolName = (record as PiMessage).toolName;
      if (typeof toolName === "string") {
        const call: ToolCall = { callId: toolCallId, name: toolName, resolved: false };
        if ((record as PiMessage).isError === true) {
          call.isError = true;
        }
        toolCalls.push(call);
      } else {
        const call = toolCalls.find((candidate) => candidate.callId === toolCallId);
        if (call !== undefined) {
          call.resolved = true;
        }
      }
    }
  }

  // One episode per branch, deterministic order (branch-graph.ts).
  const branches = buildBranches(nodes);
  const ownership = assignTokenOwnership(branches, usageMessageIds);
  const episodes: Episode[] = branches.map((branch) => {
    const events: ParsedRecord[] = [];
    const lineRefs: number[] = [];
    for (const node of branch.path) {
      const record = recordByLine.get(node.line);
      if (record === undefined) {
        continue;
      }
      events.push(record);
      lineRefs.push(node.line);
    }
    const episode: Episode = { branchId: branch.branchId, events, lineRefs };
    const owned = ownership.get(branch.branchId);
    if (owned !== undefined) {
      episode.ownedMessageIds = owned;
    }
    episode.isPrimary = branch.isPrimary;
    return episode;
  });

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
  if (appVersion !== undefined) {
    result.appVersion = appVersion;
  }
  if (latestRecordTimestamp !== undefined) {
    result.latestRecordTimestamp = latestRecordTimestamp;
  }
  return result;
}
