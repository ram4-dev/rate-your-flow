/**
 * Shared contract barrel: schema tags, types, and runtime guards for
 * analysis@1, digest@1, consent@1, and the error envelope.
 */

export * from "./analysis@1.js";
export * from "./consent@1.js";
export * from "./digest@1.js";
export * from "./errors.js";

/**
 * Cheap runtime guard: asserts a parsed payload carries the expected schema
 * tag. Throws a TypeError on any non-object payload, missing tag, or mismatch.
 */
export function assertSchemaTag(value: unknown, expected: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    (value as { schema?: unknown }).schema !== expected
  ) {
    throw new TypeError(`expected schema tag "${expected}"`);
  }
}
