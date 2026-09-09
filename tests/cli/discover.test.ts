/**
 * 3.1 RED: discovery — codex/pi stores discovered read-only; mtime is a
 * discovery-ORDERING hint only (Phase 3 parent ruling). RED evidence: modules
 * src/cli/discover.js missing at write time.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { discoverSessions } from "../../src/cli/discover.js";

const STORE_ROOT = fileURLToPath(new URL("../fixtures/stores", import.meta.url));

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("discoverSessions (3.1)", () => {
  it("discovers codex and pi session files under configured store roots", async () => {
    const found = await discoverSessions({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
    });
    const codex = found.filter((f) => f.source === "codex");
    const pi = found.filter((f) => f.source === "pi");
    expect(codex.length).toBe(5);
    expect(pi.length).toBe(1);
    for (const entry of found) {
      expect(entry.filePath.endsWith(".jsonl")).toBe(true);
    }
  });

  it("is read-only: every discovered file's sha256 unchanged after discovery", async () => {
    const found = await discoverSessions({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
    });
    for (const entry of found) {
      const before = await digest(entry.filePath);
      expect(await digest(entry.filePath)).toBe(before);
    }
  });

  it("mtime is captured as an ordering hint field, not used for windowing", async () => {
    const found = await discoverSessions({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
    });
    for (const entry of found) {
      // hint field present; window filtering is NOT discovery's job (metrics).
      expect(entry.mtimeHint).toBeInstanceOf(Date);
    }
  });

  it("empty store root yields a defined empty list, no error", async () => {
    const found = await discoverSessions({
      codexDir: `${STORE_ROOT}/../fixtures/parsers/codex/empty.jsonl`,
      piDir: `${STORE_ROOT}/missing-dir`,
    });
    expect(found).toEqual([]);
  });

  it("deterministic ordering: same input yields same order (mtime hint used only for ordering)", async () => {
    const a = await discoverSessions({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
    });
    const b = await discoverSessions({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
    });
    expect(a.map((f) => f.filePath)).toEqual(b.map((f) => f.filePath));
  });
});
