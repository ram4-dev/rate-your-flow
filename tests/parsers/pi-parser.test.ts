import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sumAttributedTokens } from "../../src/cli/branch-graph.js";
import { parsePiSession } from "../../src/cli/parsers/pi@1.js";

const FIXTURE = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/parsers/pi/${name}`, import.meta.url));

async function fixtureDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("pi@1 parser (U2b)", () => {
  it("(a) declares sourceVersion pi@1, session id from the session record, read-only", async () => {
    const path = FIXTURE("valid.jsonl");
    const before = await fixtureDigest(path);
    const session = await parsePiSession(path);
    const after = await fixtureDigest(path);

    expect(after).toBe(before);
    expect(session.source).toBe("pi");
    expect(session.sourceVersion).toBe("pi@1");
    expect(session.sessionId).toBe("sess-pi-001");
    expect(session.filePath).toBe(path);
  });

  it("(b) emits one episode per branch with deterministic linearization", async () => {
    const session = await parsePiSession(FIXTURE("branches.jsonl"));
    expect(session.episodes).toHaveLength(2);

    const [first, second] = session.episodes;
    // Deterministic order: branches share the root timestamp -> tie broken by
    // the joined id path, so a1 comes before b1.
    expect(first?.branchId).toBe("a1");
    expect(second?.branchId).toBe("b1");
    // Primary path = parent chain of the last event (b1 @ 10:00:03).
    expect(first?.isPrimary).toBe(false);
    expect(second?.isPrimary).toBe(true);
    // Episode events are the full root->leaf path.
    expect(first?.events.map((event) => (event.payload as { id?: string }).id)).toEqual([
      "r1",
      "a1",
    ]);
    expect(second?.events.map((event) => (event.payload as { id?: string }).id)).toEqual([
      "r1",
      "b1",
    ]);
  });

  it("(c) attributes each usage record exactly once — shared ancestors never double-counted", async () => {
    const session = await parsePiSession(FIXTURE("branches-shared-usage.jsonl"));
    const totals = sumAttributedTokens(session);
    // s1 (5, shared ancestor, counted once) + sa (11) + sb (22) = 38.
    expect(totals).toEqual({ input: 35, output: 3, total: 38 });

    // Every usage-bearing message is owned by exactly one episode.
    const owned = session.episodes.flatMap((episode) => episode.ownedMessageIds ?? []);
    const usageIds = session.tokenEvents
      .map((event) => event.sourceId)
      .filter((id): id is string => id !== undefined);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual([...usageIds].sort());
    // The shared ancestor is owned by the primary branch.
    const primary = session.episodes.find((episode) => episode.isPrimary);
    expect(primary?.ownedMessageIds).toContain("s1");
  });

  it("(d) correlates toolCallId/toolName/isError; repeated polling is not an error", async () => {
    const session = await parsePiSession(FIXTURE("tools.jsonl"));
    const byId = new Map(session.toolCalls.map((call) => [call.callId, call]));

    const failing = byId.get("tc-fail-1");
    expect(failing?.name).toBe("write_report");
    expect(failing?.isError).toBe(true);
    expect(failing?.resolved).toBe(true);

    // Repeated toolName + similar args (polling) is a fresh call, never an error.
    for (const id of ["tc-poll-1", "tc-poll-2"]) {
      const poll = byId.get(id);
      expect(poll?.name).toBe("read_queue");
      expect(poll?.isError).not.toBe(true);
      expect(poll?.resolved).toBe(true);
    }
  });

  it("(d2) valid fixture: unmatched tool call stays unresolved and not an error", async () => {
    const session = await parsePiSession(FIXTURE("valid.jsonl"));
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({ callId: "tc1", name: "bash", resolved: false });
    expect(session.toolCalls[0]?.isError).not.toBe(true);
  });

  it("(e) latestRecordTimestamp is the max message timestamp", async () => {
    expect((await parsePiSession(FIXTURE("branches.jsonl"))).latestRecordTimestamp).toBe(
      "2026-08-02T10:00:03Z",
    );
    expect((await parsePiSession(FIXTURE("valid.jsonl"))).latestRecordTimestamp).toBe(
      "2026-08-02T09:00:04Z",
    );
  });

  it("(f) reads a version field when present without assuming its value", async () => {
    const versioned = await parsePiSession(FIXTURE("versioned.jsonl"));
    expect(versioned.appVersion).toBe("v3");
    expect(versioned.sourceVersion).toBe("pi@1");

    const plain = await parsePiSession(FIXTURE("valid.jsonl"));
    expect(plain.appVersion).toBeUndefined();
  });

  it("single-branch session: one primary episode with aligned events and line refs", async () => {
    const session = await parsePiSession(FIXTURE("valid.jsonl"));
    expect(session.episodes).toHaveLength(1);
    const episode = session.episodes[0];
    expect(episode?.isPrimary).toBe(true);
    expect(episode?.branchId).toBe("m3");
    expect(episode?.lineRefs).toEqual([2, 3, 4, 5]);
    expect(episode?.lineRefs).toHaveLength(episode?.events.length ?? -1);
    expect(session.records).toHaveLength(5);
  });
});
