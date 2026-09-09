/**
 * P2 (11-parser-review): timestamp comparisons MUST be instant-based
 * (epoch ms), never lexicographic. RED evidence (pre-fix behavior, recorded):
 * comparing "2026-06-05T10:00:09Z" > "2026-06-05T10:00:09.500Z" lexicographically
 * returns true ('Z' > '.') although the fractional timestamp is LATER; and
 * "2026-06-05T10:00:09Z" > "2026-06-05T07:00:09.500-03:00" lexicographically
 * returns true although the -03:00 record is the later instant.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSession } from "../../src/cli/parsers/codex@1.js";
import { compareTimestamps, toEpochMs } from "../../src/cli/parsers/timestamps.js";

const PATH = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/parsers/codex/${name}`, import.meta.url));

describe("timestamp instants (P2)", () => {
  it("fractional seconds sort after plain seconds", () => {
    expect(compareTimestamps("2026-06-05T10:00:09.500Z", "2026-06-05T10:00:09Z")).toBeGreaterThan(
      0,
    );
  });

  it("mixed UTC offsets compare by instant, not string", () => {
    // "07:00:09.500-03:00" == 10:00:09.500Z — the later instant.
    expect(
      compareTimestamps("2026-06-05T07:00:09.500-03:00", "2026-06-05T10:00:09Z"),
    ).toBeGreaterThan(0);
  });

  it("invalid timestamps sort last and toEpochMs guards NaN", () => {
    expect(toEpochMs("not-a-date")).toBeUndefined();
    expect(toEpochMs(42)).toBeUndefined();
    expect(compareTimestamps("2026-06-05T10:00:09Z", "not-a-date")).toBeLessThan(0);
  });

  it("parser latestRecordTimestamp picks the true latest instant (mixed-offset fixture)", async () => {
    const session = await parseCodexSession(PATH("timestamps-mixed.jsonl"));
    // Records: 10:00:09Z, 10:00:09.500Z, 07:00:10.500-03:00 (=10:00:10.500Z).
    // Lexicographic max would be "…:09Z" ('Z' > '.'); the correct instant max
    // is the mixed-offset record.
    expect(session.latestRecordTimestamp).toBe("2026-06-05T07:00:10.500-03:00");
  });
});
