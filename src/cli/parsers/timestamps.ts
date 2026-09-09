/**
 * Timestamp instant helpers (11-parser-review P2).
 *
 * ISO-8601 strings MUST NOT be compared lexicographically: mixed UTC offsets
 * ("-03:00") and fractional seconds ("…:09.500Z" vs "…:09Z") compare wrongly
 * as strings. All timestamp comparisons go through epoch-millisecond instants.
 */

/** Parse an ISO-8601 timestamp to epoch ms; undefined for invalid input. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? undefined : epoch;
}

/** Compare two timestamp values as instants; non-timestamps sort last. */
export function compareTimestamps(a: unknown, b: unknown): number {
  const aMs = toEpochMs(a);
  const bMs = toEpochMs(b);
  if (aMs === undefined && bMs === undefined) return 0;
  if (aMs === undefined) return 1;
  if (bMs === undefined) return -1;
  return aMs - bMs;
}

/** Max of the current latest and a candidate timestamp (by instant). */
export function maxTimestampByInstant(
  current: string | undefined,
  candidate: unknown,
): string | undefined {
  if (typeof candidate !== "string") {
    return current;
  }
  if (
    current === undefined ||
    (compareTimestamps(candidate, current) > 0 && toEpochMs(candidate) !== undefined)
  ) {
    return candidate;
  }
  return current;
}
