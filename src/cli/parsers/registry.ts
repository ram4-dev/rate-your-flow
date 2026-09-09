/**
 * Versioned parser registry keyed by source tag (design D6).
 *
 * Both `codex@1` and `pi@1` are implemented as async parsers (Promise<Session>);
 * unknown tags throw a typed UnknownSourceError.
 */

import { parseCodexSession } from "./codex@1.js";
import { parsePiSession } from "./pi@1.js";
import type { Session, SourceVersion } from "./model.js";

export type SessionParser = (filePath: string) => Promise<Session>;

/** Thrown when a source tag is not registered at all. */
export class UnknownSourceError extends Error {
  constructor(source: string) {
    super(`No parser registered for source: ${source}`);
    this.name = "UnknownSourceError";
  }
}

const REGISTRY: Record<SourceVersion, SessionParser> = {
  "codex@1": parseCodexSession,
  "pi@1": parsePiSession,
};

/** Resolve the versioned parser for a source tag. Throws for unknown tags. */
export function getParser(source: string): SessionParser {
  if (source === "codex@1" || source === "pi@1") {
    return REGISTRY[source];
  }
  throw new UnknownSourceError(source);
}

/** Map a bare source family ("codex" | "pi") to its versioned registry key. */
export function getParserForSource(source: "codex" | "pi"): SessionParser {
  return source === "codex" ? REGISTRY["codex@1"] : REGISTRY["pi@1"];
}
