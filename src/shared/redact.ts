/**
 * Conservative pattern-based redaction of secret-like strings.
 *
 * Runs before digest finalize so the rendered preview always equals the
 * sent payload (consent-privacy spec: redact-before-send). Patterns are
 * deliberately conservative: they target bearer tokens, well-known key
 * prefixes (sk-, ghp_, AKIA…), long random hex/base64 tokens, and
 * env-style secret assignments. Normal prose, short identifiers, and
 * ordinary URLs are left untouched.
 */

/** Marker used to replace every redacted secret. */
export const REDACTED = "[REDACTED]" as const;

/**
 * `Authorization: Bearer <token>` — token replaced, scheme kept. Case-insensitive
 * (lowercase `bearer` in captured shell/config text must redact too).
 */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-_.~+/=]{16,}\b/gi;

/** Secret-ish key names for env/JSON-style assignments. */
const SECRET_KEY_NAMES =
  "api_?key|api_?secret|secret|token|password|passwd|private_?key|access_?key|credential|pass|pwd|auth";

/**
 * Env/JSON-style secret assignment: `KEY=value`, `KEY: 'value'`, JSON
 * `"key": "value"`. Quoted values (double or single) are redacted whole,
 * including spaces (C1); unquoted values are a single non-space token (>= 4
 * chars) so ordinary prose with a colon is never nuked wholesale.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b([A-Za-z0-9_.-]*(?:${SECRET_KEY_NAMES})[A-Za-z0-9_.-]*)\\s*["']?\\s*([:=])\\s*("[^"\\n]*"|'[^'\\n]*'|[^\\s"']{4,})`,
  "gi",
);

/**
 * Password-class keys only: an unquoted rest-of-line value is still ambiguous
 * with prose, so the whole tail is redacted just for high-signal keys
 * (password/passwd/pwd), never for generic words like pass/auth/token.
 */
const PASSWORD_LINE = new RegExp(
  `\\b([A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*)\\s*([:=])[^\\n]*`,
  "gi",
);

/** OpenAI-style `sk-…` keys. */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

/** GitHub-style prefixed tokens. */
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g;

/** AWS access key ids. */
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

/** Long random hex tokens (>= 32 hex chars). */
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;

/** Long base64/base64url-looking tokens (>= 40 chars). */
const LONG_BASE64 = /\b[A-Za-z0-9+/=_-]{40,}={0,2}\b/g;

function replaceAll(
  text: string,
  pattern: RegExp | null,
  replacer: string | ((...args: string[]) => string),
): string {
  if (!pattern) return text;
  pattern.lastIndex = 0;
  return text.replace(pattern, replacer as never);
}

/**
 * Returns `text` with every secret-like substring replaced by `REDACTED`.
 * Pure function; safe to run repeatedly (idempotent on already-redacted text).
 */
export function redact(text: string): string {
  let out = text;
  out = replaceAll(out, BEARER_TOKEN, () => `Bearer ${REDACTED}`);
  out = replaceAll(
    out,
    SECRET_ASSIGNMENT,
    (_m: string, key: string, sep: string) => `${key}${sep} ${REDACTED}`,
  );
  out = replaceAll(
    out,
    PASSWORD_LINE,
    (_m: string, key: string, sep: string) => `${key}${sep} ${REDACTED}`,
  );
  out = replaceAll(out, SK_KEY, REDACTED);
  out = replaceAll(out, GITHUB_TOKEN, REDACTED);
  out = replaceAll(out, AWS_ACCESS_KEY, REDACTED);
  out = replaceAll(out, LONG_HEX, REDACTED);
  out = replaceAll(out, LONG_BASE64, REDACTED);
  return out;
}
