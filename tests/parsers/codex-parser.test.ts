import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSession } from "../../src/cli/parsers/codex@1.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/parsers/codex/valid.jsonl", import.meta.url),
);

async function fixtureDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("codex@1 parser", () => {
  it("(a) declares sourceVersion codex@1 and session id from session_meta", async () => {
    const session = await parseCodexSession(FIXTURE_PATH);
    expect(session.source).toBe("codex");
    expect(session.sourceVersion).toBe("codex@1");
    expect(session.sessionId).toBe("codex-sess-001");
    expect(session.filePath).toBe(FIXTURE_PATH);
  });

  it("(b) is read-only: fixture sha256 unchanged after parse", async () => {
    const before = await fixtureDigest(FIXTURE_PATH);
    await parseCodexSession(FIXTURE_PATH);
    const after = await fixtureDigest(FIXTURE_PATH);
    expect(after).toBe(before);
  });

  it("(c) correlates tool calls via call_id; repeated call_id is not an error", async () => {
    const session = await parseCodexSession(FIXTURE_PATH);
    const byId = new Map(session.toolCalls.map((tc) => [tc.callId, tc]));

    const paired = byId.get("call_abc123");
    expect(paired).toBeDefined();
    expect(paired?.name).toBe("shell");
    // One function_call + two outputs with the same call_id: resolved, never an error.
    expect(paired?.resolved).toBe(true);
    expect(paired?.isError).not.toBe(true);

    const unmatched = byId.get("call_unmatched99");
    expect(unmatched).toBeDefined();
    expect(unmatched?.name).toBe("read_file");
    expect(unmatched?.resolved).toBe(false);
  });

  it("(d) records line refs for every record and episode events", async () => {
    const session = await parseCodexSession(FIXTURE_PATH);
    // 10 fixture lines, all parsed as records, 1-based refs.
    expect(session.records).toHaveLength(10);
    session.records.forEach((record, index) => {
      expect(record.line).toBe(index + 1);
    });
    // session_meta is line 1.
    expect(session.records[0]?.type).toBe("session_meta");

    // Episodes start at user messages; tool outputs/messages append.
    expect(session.episodes.length).toBeGreaterThan(0);
    for (const episode of session.episodes) {
      expect(episode.events.length).toBeGreaterThan(0);
      expect(episode.lineRefs.length).toBe(episode.events.length);
      for (const lineRef of episode.lineRefs) {
        expect(session.records.some((record) => record.line === lineRef)).toBe(true);
      }
    }
  });

  it("(e) latestRecordTimestamp is the max record timestamp", async () => {
    const session = await parseCodexSession(FIXTURE_PATH);
    expect(session.latestRecordTimestamp).toBe("2026-08-01T10:00:09Z");
  });

  it("parses token events (usage); accumulated variants marked unverified", async () => {
    const session = await parseCodexSession(FIXTURE_PATH);
    expect(session.tokenEvents).toHaveLength(1);
    const event = session.tokenEvents[0];
    expect(event?.recordType).toBe("usage");
    expect(event?.counts["total_tokens"]).toBe(165);
    expect(event?.verified).toBe(false);

    const accumulated = await parseCodexSession(
      new URL("../fixtures/parsers/codex/tokens-accumulated.jsonl", import.meta.url).pathname,
    );
    const types = accumulated.tokenEvents.map((event) => event.recordType);
    expect(types).toContain("thread_token_usage");
    expect(types).toContain("turn_token_usage");
    for (const event of accumulated.tokenEvents) {
      expect(event.verified).toBe(false);
    }
  });

  it("loads all synthetic codex fixtures without mutation", async () => {
    for (const name of [
      "valid.jsonl",
      "corrupted.jsonl",
      "truncated.jsonl",
      "active.jsonl",
      "tokens-accumulated.jsonl",
    ]) {
      const path = new URL(`../fixtures/parsers/codex/${name}`, import.meta.url).pathname;
      const before = await fixtureDigest(path);
      expect(await readFile(path, "utf8").then((text) => text.length)).toBeGreaterThan(0);
      // Read-only guarantee is byte-level; corrupt/truncated may throw in U2a
      // (robustness is U2c), so only assert digest equality when parse succeeds.
      try {
        await parseCodexSession(path);
      } catch {
        // acceptable until U2c robustness lands
      }
      expect(await fixtureDigest(path)).toBe(before);
    }
  });
});
