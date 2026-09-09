import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "./redact.js";

describe("redact (conservative, pattern-based)", () => {
  it("redacts OpenAI-style sk- keys", () => {
    const input = "using key sk-abcdefghijklmnopqrstuvwxyz123456 today";
    expect(redact(input)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redact(input)).toContain(REDACTED);
  });

  it("redacts bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.foo.sig";
    const out = redact(input);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).toContain(REDACTED);
    expect(out).toContain("Authorization:");
  });

  it("redacts GitHub-style prefixed tokens", () => {
    for (const tok of [
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "github_pat_0123456789abcdefghij",
    ]) {
      const out = redact(`token ${tok} end`);
      expect(out).not.toContain(tok);
      expect(out).toContain(REDACTED);
    }
  });

  it("redacts AWS access key ids", () => {
    const tok = "AKIAIOSFODNN7EXAMPLE";
    const out = redact(`aws ${tok}`);
    expect(out).not.toContain(tok);
    expect(out).toContain(REDACTED);
  });

  it("redacts long random hex tokens", () => {
    const tok = "a".repeat(40).replace(/a/g, "a") + "1b2c3d4e5f"; // 50 hex chars
    const hex = "deadbeefcafebabe0123456789abcdef0123456789abcdef";
    const out = redact(`sig ${hex}`);
    expect(out).not.toContain(hex);
    expect(out).toContain(REDACTED);
    void tok;
  });

  it("redacts env-style secret assignments (KEY=value)", () => {
    for (const line of [
      "API_KEY=supersecretvalue123",
      "OPENAI_API_TOKEN: 'sk-live-abcdefghij0123456789'",
      'MY_DB_PASSWORD = "hunter2"',
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ]) {
      const out = redact(line);
      expect(out).not.toContain(
        line
          .split(/[=:]/)[1]!
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .slice(0, 8),
      );
      expect(out).toContain(REDACTED);
    }
  });

  it("redacts long base64url-looking tokens", () => {
    const tok = "dGhpc2lzYXZlcnlsb25nYmFzZTY0dG9rZW53aXRobm9kYXRhYQ";
    const out = redact(`refresh ${tok}`);
    expect(out).not.toContain(tok);
    expect(out).toContain(REDACTED);
  });

  it("leaves normal text untouched", () => {
    const normal =
      "Session 2026-02-07: refactored the parser registry, ran 12 tests, all green. Line 42 fixed the import path.";
    expect(redact(normal)).toBe(normal);
  });

  it("leaves short identifiers and words untouched (no over-redaction)", () => {
    const normal = "used uuid 4f2a1b8c for the session id; word length is 5";
    expect(redact(normal)).toBe(normal);
  });

  it("leaves ordinary URLs intact", () => {
    const url = "see https://example.com/docs/getting-started for details";
    expect(redact(url)).toBe(url);
  });

  it("is idempotent on already-redacted text", () => {
    const once = redact("key sk-abcdefghijklmnopqrstuvwxyz123456 here");
    expect(redact(once)).toBe(once);
  });

  // C1 (09-code-review-u1.md): quoted secrets containing spaces must be
  // redacted whole, not partially.
  it("redacts a double-quoted secret with spaces entirely (C1)", () => {
    const input = 'password: "correct horse battery"';
    const out = redact(input);
    expect(out).not.toContain("correct horse");
    expect(out).not.toContain("battery");
    expect(out).toContain(REDACTED);
  });

  it("redacts a single-quoted secret with spaces entirely (C1)", () => {
    const input = "DB_PASS='correct horse battery'";
    const out = redact(input);
    expect(out).not.toContain("correct horse");
    expect(out).toContain(REDACTED);
  });

  it("redacts an unquoted multi-word password value (C1)", () => {
    const input = "password: my secret phrase";
    const out = redact(input);
    expect(out).not.toContain("secret phrase");
    expect(out).toContain(REDACTED);
  });

  it("redacts a representative JSON credential key/value with spaces (C1)", () => {
    const input = '{"client_secret": "top secret value 99", "note": "keep"}';
    const out = redact(input);
    expect(out).not.toContain("top secret value 99");
    expect(out).toContain(REDACTED);
    // Unrelated neighboring JSON content survives.
    expect(out).toContain('"note": "keep"');
  });

  // C2 (09-code-review-u1.md): bearer scheme is case-insensitive.
  it("redacts a lowercase bearer token (C2)", () => {
    const input = "authorization: bearer abcdefghijklmnopqrst";
    const out = redact(input);
    expect(out).not.toContain("abcdefghijklmnopqrst");
    expect(out).toContain(REDACTED);
  });

  // Guard: keyword additions must not become a reckless greedy regex that
  // deletes unrelated prose lines.
  it("leaves prose that merely contains pass/auth-like words untouched", () => {
    const lines = [
      "the test passed: 12 tests ok",
      "the auth passed: all checks ok",
      "password policy: updated docs",
      "token count was 4032 across sessions",
    ];
    for (const line of lines) {
      expect(redact(line)).toBe(line);
    }
  });
});
