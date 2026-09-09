/**
 * Read-only session discovery (Phase 3, tasks 3.1/3.1b).
 *
 * Finds Codex and pi JSONL session files under configured store roots.
 * READ-ONLY: files are only stat'd and listed — never written.
 *
 * mtime is captured as an ORDERING HINT only (parent ruling): windowing is
 * exclusively by record timestamps in the metrics layer; a recently touched
 * file containing only old records never enters the 90-day window through
 * mtime.
 *
 * Ordering is deterministic: by source, then mtime hint descending, then
 * path — so identical inputs yield identical order.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DiscoveredSessionFile {
  source: "codex" | "pi";
  filePath: string;
  /** Discovery-ORDERING hint only. Never used for window filtering. */
  mtimeHint: Date;
}

export interface DiscoverOptions {
  codexDir?: string;
  piDir?: string;
  /** HOME used for DEFAULT store roots when explicit dirs are absent. */
  home?: string;
}

/** Default store roots under a HOME (recursive: date subdirectories). */
export function defaultStoreRoots(home: string): { codexDir: string; piDir: string } {
  return {
    codexDir: join(home, ".codex", "sessions"),
    piDir: join(home, ".pi", "agent", "sessions"),
  };
}

const MAX_WALK_DEPTH = 6;

async function listJsonlFilesRecursive(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(join(dir, entry.name));
    } else if (entry.isDirectory()) {
      files.push(...(await listJsonlFilesRecursive(join(dir, entry.name), depth + 1)));
    }
  }
  return files.sort();
}

/** Discover session files under the given store roots (read-only). */
export async function discoverSessions(options: DiscoverOptions): Promise<DiscoveredSessionFile[]> {
  const results: DiscoveredSessionFile[] = [];
  const defaults = options.home !== undefined ? defaultStoreRoots(options.home) : undefined;
  const roots: Array<{ source: "codex" | "pi"; dir?: string | undefined }> = [
    { source: "codex", dir: options.codexDir ?? defaults?.codexDir },
    { source: "pi", dir: options.piDir ?? defaults?.piDir },
  ];
  for (const { source, dir } of roots) {
    if (dir === undefined) {
      continue;
    }
    let files: string[];
    try {
      files = await listJsonlFilesRecursive(dir);
    } catch {
      continue; // missing/unreadable root: defined empty contribution
    }
    for (const filePath of files) {
      const mtimeHint = (await stat(filePath)).mtime;
      results.push({ source, filePath, mtimeHint });
    }
  }
  // Deterministic: source, then mtime hint descending (recency first), then path.
  results.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source < b.source ? -1 : 1;
    }
    const byHint = b.mtimeHint.getTime() - a.mtimeHint.getTime();
    if (byHint !== 0) {
      return byHint;
    }
    return a.filePath < b.filePath ? -1 : 1;
  });
  return results;
}
