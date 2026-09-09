/**
 * Common intermediate model for versioned session parsers.
 *
 * Types only — no behavior. Parsers (codex@1, pi@1) fill these structures;
 * later work units (U2b/U2c) extend them (branch graphs, robustness fields).
 */

/** Versioned parser sources. Registry keys MUST match these tags. */
export const SOURCE_VERSIONS = ["codex@1", "pi@1"] as const;

export type SourceVersion = (typeof SOURCE_VERSIONS)[number];

/** One parsed source line. `line` is 1-based within the source file. */
export interface ParsedRecord {
  line: number;
  type: string;
  /** ISO-8601 UTC timestamp when the source provides one. */
  timestamp?: string;
  payload: unknown;
}

/**
 * A contiguous exchange grouping. For codex@1 a single linear branch; for
 * pi@1 one episode per id/parentId branch (U2b).
 */
export interface Episode {
  branchId: string;
  events: ParsedRecord[];
  /** 1-based source line refs, aligned with `events`. */
  lineRefs: number[];
  /**
   * pi@1 only: message ids whose token usage this episode exclusively owns.
   * A message shared by several branch paths (common ancestor) is owned by the
   * primary branch alone, so cross-branch token sums never double-count it.
   */
  ownedMessageIds?: string[];
  /** pi@1 only: true for the primary branch (parent chain of the last event). */
  isPrimary?: boolean;
}

/** A tool invocation correlated with its result via `call_id`. */
export interface ToolCall {
  callId: string;
  name: string;
  isError?: boolean;
  /** True when a matching result/output was found. */
  resolved: boolean;
}

/**
 * A token-count observation. `verified` is always false until the codex
 * token-accumulation semantics are fixture-verified (gate, task 2.6/2.7).
 */
export interface TokenEvent {
  recordType: "usage" | "thread_token_usage" | "turn_token_usage";
  counts: Record<string, number>;
  verified: false;
  /** pi@1 only: id of the message this per-message usage belongs to. */
  sourceId?: string;
  /**
   * True for legacy separate top-level thread/turn records (shape 0 in the
   * real corpus): never satisfies the nested-shape semantics (U2c).
   */
  legacyShape?: true;
}

/** Non-fatal parse observation (robustness, U2c). */
export interface ParseWarning {
  line: number;
  message: string;
}

/** A fully parsed session file in the common intermediate model. */
export interface Session {
  source: string;
  sourceVersion: SourceVersion;
  sessionId: string;
  filePath: string;
  records: ParsedRecord[];
  episodes: Episode[];
  toolCalls: ToolCall[];
  tokenEvents: TokenEvent[];
  /** Max timestamp across records, if any record carries one. */
  latestRecordTimestamp?: string;
  /** pi@1 only: source `version` field read when present; never assumed. */
  appVersion?: string;
  warnings: ParseWarning[];
}
