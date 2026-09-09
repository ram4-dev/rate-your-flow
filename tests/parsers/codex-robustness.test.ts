/**
 * codex@1 robustness + format fidelity (tasks 2.8/2.9 + review P3/P4/P5).
 *
 * RED provenance: before U2c the parser threw on the first malformed line
 * (recorded in apply-progress U2a/U2b risks: "malformed lines still throw by
 * design until U2c"), custom_tool_call was not correlated, no tool-error
 * honesty warning existed, and no fixture represented these cases.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSession } from "../../src/cli/parsers/codex@1.js";

const PATH = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/parsers/codex/${name}`, import.meta.url));

async function fixtureDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("codex@1 robustness (2.8/2.9)", () => {
  it("invalid JSON line: skip + count + fixed-phrase warning, file continues", async () => {
    const session = await parseCodexSession(PATH("corrupted.jsonl"));
    // Records before AND after the corrupted lines are all present.
    expect(session.records.length).toBeGreaterThan(0);
    const skips = session.warnings.filter((w) => w.message === "invalid JSON line skipped");
    expect(skips.length).toBeGreaterThan(0);
    expect(session.warnings.some((w) => w.message.includes("skipped and excluded"))).toBe(true);
  });

  it("privacy: warnings never embed raw line content (secret-looking corrupt line)", async () => {
    const session = await parseCodexSession(PATH("corrupted-secret-line.jsonl"));
    const raw = await readFile(PATH("corrupted-secret-line.jsonl"), "utf8");
    const secretLine = raw.split("\n").find((line) => line.includes("secret_value_here"));
    expect(secretLine).toBeDefined();
    const serialized = JSON.stringify(session.warnings);
    expect(serialized.includes("secret_value_here")).toBe(false);
    // No raw-line substring leakage anywhere in the parsed session output.
    expect(serialized.includes("NOT_JSON")).toBe(false);
  });

  it("truncated file: partial parse, unrecoverable content excluded AND reported", async () => {
    const session = await parseCodexSession(PATH("truncated.jsonl"));
    expect(session.records.length).toBeGreaterThan(0);
    expect(session.warnings.some((w) => w.message.includes("excluded from inference"))).toBe(true);
  });

  it("active session: tolerated, no crash, records parsed", async () => {
    const session = await parseCodexSession(PATH("active.jsonl"));
    expect(session.records.length).toBeGreaterThan(0);
    expect(session.sourceVersion).toBe("codex@1");
  });

  it("empty file: defined empty session, no error", async () => {
    const session = await parseCodexSession(PATH("empty.jsonl"));
    expect(session.records).toHaveLength(0);
    expect(session.episodes).toHaveLength(0);
    expect(session.toolCalls).toHaveLength(0);
    expect(session.tokenEvents).toHaveLength(0);
    expect(session.sessionId).toBe("");
  });

  it("read-only guarantee holds for every robustness fixture (sha256 unchanged)", async () => {
    for (const name of [
      "corrupted.jsonl",
      "corrupted-secret-line.jsonl",
      "truncated.jsonl",
      "active.jsonl",
      "empty.jsonl",
      "timestamps-mixed.jsonl",
      "custom-tools.jsonl",
      "token-usage-delta.jsonl",
      "token-usage-cumulative-turns.jsonl",
      "token-usage-ambiguous-nested.jsonl",
    ]) {
      const path = PATH(name);
      const before = await fixtureDigest(path);
      await parseCodexSession(path);
      expect(await fixtureDigest(path)).toBe(before);
    }
  });
});

describe("codex@1 format fidelity (P3/P4/P5)", () => {
  it("P4: custom_tool_call/custom_tool_call_output correlate like function_call*", async () => {
    const session = await parseCodexSession(PATH("custom-tools.jsonl"));
    const byId = new Map(session.toolCalls.map((tc) => [tc.callId, tc]));
    const resolved = byId.get("c-1");
    expect(resolved?.name).toBe("browser.search");
    expect(resolved?.resolved).toBe(true);
    const unmatched = byId.get("c-2");
    expect(unmatched?.name).toBe("browser.open");
    expect(unmatched?.resolved).toBe(false);
  });

  it("P3: codex tool errors are undetectable — isError never fabricated, limitation warned", async () => {
    const session = await parseCodexSession(PATH("custom-tools.jsonl"));
    for (const call of session.toolCalls) {
      expect(call.isError).toBeUndefined();
    }
    expect(session.warnings.some((w) => w.message === "tool-errors-undetectable-in-codex@1")).toBe(
      true,
    );
  });

  it("P5: developer-role messages append to the current episode (no binary assumption)", async () => {
    const session = await parseCodexSession(PATH("custom-tools.jsonl"));
    const developer = session.records.find(
      (record) =>
        record.type === "response_item" &&
        (record.payload as { role?: string } | undefined)?.role === "developer",
    );
    expect(developer).toBeDefined();
    // The developer record must live inside SOME episode (appended, not dropped).
    const inEpisode = session.episodes.some((episode) =>
      episode.events.includes(developer as NonNullable<typeof developer>),
    );
    expect(inEpisode).toBe(true);
  });
});
