/**
 * install UUID lifecycle (Phase 5, tasks 5.1/5.2; analysis-backend spec:
 * "Anonymous install UUID with stable per-HOME lifecycle").
 *
 * - Strict UUID format only (8-4-4-4-12 lowercase hex); a malformed file is
 *   replaced (root U4 review: the previous loose 36-char regex accepted
 *   garbage).
 * - Atomic first-create: `wx` exclusive write; a losing concurrent creator
 *   re-reads the winner's value, so simultaneous processes converge on ONE
 *   stable UUID per HOME.
 * - Owner-only permissions (0600); no account, no PII.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Config directory root for a HOME (POSIX: $HOME/.config/ryf). */
function ryfDirFor(home: string): string {
  return join(home, ".config", "ryf");
}

/** Absolute path of the install-UUID file for a HOME. */
export function installUUIDFilePathFor(home: string): string {
  return join(ryfDirFor(home), "install-uuid");
}

function readStoredUuid(file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const existing = readFileSync(file, "utf8").trim();
  return STRICT_UUID_RE.test(existing) ? existing : undefined;
}

/**
 * Return the HOME's install UUID, creating + persisting it on first use.
 * Exclusive-create (wx) so simultaneous processes converge on one value:
 * the loser of the create race re-reads the winner's stored UUID.
 */
export function getOrCreateInstallUUID(home: string): string {
  const dir = ryfDirFor(home);
  mkdirSync(dir, { recursive: true });
  const file = installUUIDFilePathFor(home);

  const existing = readStoredUuid(file);
  if (existing !== undefined) {
    return existing;
  }

  const uuid = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      // Exclusive create: fails if another process created it concurrently.
      fd = openSync(file, "wx");
      writeSync(fd, uuid, 0, "utf8");
      chmodSync(file, 0o600);
      return uuid;
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed by the failed write path
        }
      }
      // Lost the race (or a malformed file blocked creation): re-read the
      // winner's value; if the file holds NO valid UUID, replace it once and
      // retry (strict-format invariant over a garbage pre-existing file).
      const winner = readStoredUuid(file);
      if (winner !== undefined) {
        return winner;
      }
      try {
        unlinkSync(file);
      } catch {
        // nothing to remove; retry will surface a real error if persistent
      }
    }
  }
  throw new Error("install-uuid could not be created or repaired after concurrent attempts");
}
