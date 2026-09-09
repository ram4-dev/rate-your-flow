/**
 * Deterministic id/parentId branch-graph linearization (design D6).
 *
 * For pi@1 sessions: episodes are emitted per branch; the primary path is the
 * parent chain of the session's last event; branch ordering is deterministic
 * (first timestamp, tie by the joined id path, final tie by leaf id). Token
 * attribution is exclusive — a usage-bearing message shared by several branch
 * paths (a common ancestor) is owned by exactly one branch (the primary), so
 * cross-branch sums never double-count it.
 */

import type { Session } from "./parsers/model.js";
import { compareTimestamps } from "./parsers/timestamps.js";

/** One graph node: a source record carrying `id` + `parentId`. */
export interface BranchNode {
  id: string;
  parentId: string | null;
  /** ISO-8601 UTC timestamp when the source provides one. */
  timestamp?: string;
  /** 1-based source line the record came from. */
  line: number;
}

export interface Branch {
  /** Leaf node id — unique per branch path. */
  branchId: string;
  /** Root → leaf chain of nodes. */
  path: BranchNode[];
  /** True for the branch containing the session's last event. */
  isPrimary: boolean;
}

/**
 * Build branches from graph nodes. Nodes whose parent id has no matching node
 * are treated as roots; the parent-chain walk is guarded against cycles.
 */
export function buildBranches(nodes: BranchNode[]): Branch[] {
  const byId = new Map<string, BranchNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  const referencedAsParent = new Set(
    nodes.flatMap((node) => (node.parentId === null ? [] : [node.parentId])),
  );
  const leaves = nodes.filter((node) => !referencedAsParent.has(node.id));

  // The session's last event: max by timestamp INSTANT (never
  // lexicographic — mixed offsets/fractional seconds; P2), then id.
  let lastEvent: BranchNode | undefined;
  for (const node of nodes) {
    if (lastEvent === undefined) {
      lastEvent = node;
      continue;
    }
    const instant = compareTimestamps(node.timestamp, lastEvent.timestamp);
    if (instant > 0 || (instant === 0 && node.id > lastEvent.id)) {
      lastEvent = node;
    }
  }

  const branches: Branch[] = [];
  for (const leaf of leaves) {
    const path: BranchNode[] = [];
    const visited = new Set<string>();
    let cursor: BranchNode | undefined = leaf;
    while (cursor !== undefined && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      path.push(cursor);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    path.reverse();
    branches.push({
      branchId: leaf.id,
      path,
      isPrimary: lastEvent !== undefined && path.includes(lastEvent),
    });
  }

  branches.sort((a, b) => {
    const rootInstant = compareTimestamps(a.path[0]?.timestamp, b.path[0]?.timestamp);
    if (rootInstant !== 0) {
      return rootInstant;
    }
    const aPath = a.path.map((node) => node.id).join("/");
    const bPath = b.path.map((node) => node.id).join("/");
    if (aPath !== bPath) {
      return aPath < bPath ? -1 : 1;
    }
    return a.branchId < b.branchId ? -1 : 1;
  });

  return branches;
}

/**
 * Assign exclusive token ownership. A usage-bearing message that appears in
 * exactly one branch path is owned by that branch; a message shared by
 * several paths (common ancestor) is owned by the primary branch (or the
 * deterministically first branch when no primary exists).
 *
 * @returns map of branchId → owned message ids.
 */
export function assignTokenOwnership(
  branches: Branch[],
  usageMessageIds: string[],
): Map<string, string[]> {
  const ownership = new Map<string, string[]>();
  const primary = branches.find((branch) => branch.isPrimary);
  for (const id of usageMessageIds) {
    const containing = branches.filter((branch) => branch.path.some((node) => node.id === id));
    const owner = containing.find((branch) => branch === primary) ?? containing[0];
    if (owner === undefined) {
      continue; // orphan message: no branch path contains it
    }
    const owned = ownership.get(owner.branchId) ?? [];
    owned.push(id);
    ownership.set(owner.branchId, owned);
  }
  return ownership;
}

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

/**
 * Sum token usage across a pi@1 session via episode ownership: each
 * usage-bearing message contributes to exactly one episode, so shared
 * ancestors are counted exactly once across all branches.
 */
export function sumAttributedTokens(session: Session): TokenTotals {
  const usageById = new Map<string, Record<string, number>>();
  for (const event of session.tokenEvents) {
    if (event.sourceId !== undefined) {
      usageById.set(event.sourceId, event.counts);
    }
  }
  const totals: TokenTotals = { input: 0, output: 0, total: 0 };
  for (const episode of session.episodes) {
    for (const id of episode.ownedMessageIds ?? []) {
      const counts = usageById.get(id);
      if (counts === undefined) {
        continue;
      }
      totals.input += counts["input"] ?? 0;
      totals.output += counts["output"] ?? 0;
      totals.total += counts["total"] ?? 0;
    }
  }
  return totals;
}
