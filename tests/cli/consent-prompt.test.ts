/**
 * Unit A task 1.10 (RED → GREEN): first-use `--json` stdout purity.
 *
 * The default interactive consent callback MUST emit the preview + readline
 * prompt to STDERR, never STDOUT, so a first-use `--json` run does not
 * contaminate the final JSON/path stdout. It suspends the in-progress stderr
 * progress line before the prompt, and reads the author's y/N answer from
 * stdin. RED: the current callback writes the preview/prompt to stdout.
 */
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDefaultConsentPrompt } from "../../src/cli/bin.js";
import { createProgressReporter } from "../../src/cli/progress.js";

/**
 * A real Writable that records the string chunks written to it. Readline needs a
 * real stream (it calls output.on/once), so a plain {write} object is NOT valid.
 */
function captureStream(isTTY: boolean): {
  chunks: string[];
  stream: Writable & { isTTY?: boolean };
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as Writable & { isTTY?: boolean };
  if (isTTY) {
    stream.isTTY = true;
  }
  return { chunks, stream };
}

const PREVIEW = "digest@1\nsome cited snippets for the author to review";

describe("createDefaultConsentPrompt — first-use stdout purity (1.10)", () => {
  it("writes the preview + prompt to STDERR and never to STDOUT (grants on 'y')", async () => {
    const stdin = new PassThrough();
    const outCapture = captureStream(false); // stdout: NOT a TTY for readline
    const errCapture = captureStream(true); // stderr: TTY for the progress reporter
    // Establish a live TTY progress line that must be suspended/cleared before
    // the prompt lands (so the prompt is not appended onto a bar/spinner).
    const progress = createProgressReporter({ stream: errCapture.stream });
    progress.stage("Preparing analysis");

    const prompt = createDefaultConsentPrompt({
      stdin,
      stdout: outCapture.stream as unknown as NodeJS.WritableStream,
      stderr: errCapture.stream as unknown as NodeJS.WritableStream,
      progress,
    });
    const pending = prompt({ destination: "http://127.0.0.1:1", preview: PREVIEW });
    stdin.write("y\n");
    const granted = await pending;

    expect(granted).toBe(true);
    // STDOUT purity: the consent interaction writes nothing to stdout.
    expect(outCapture.chunks.join("")).toBe("");
    // The preview + prompt text live on STDERR.
    const err = errCapture.chunks.join("");
    expect(err).toContain("ryf will send a redacted digest to http://127.0.0.1:1");
    expect(err).toContain("Preview:");
    expect(err).toContain("digest@1");
    expect(err).toContain("Consent? [y/N]");
    // The in-progress TTY line is cleared/suspended BEFORE the prompt lands.
    expect(err).toContain("\r\x1b[2Kryf will send a redacted digest to http://127.0.0.1:1");
  });

  it("refuses (returns false) on 'n' with no STDOUT writes", async () => {
    const stdin = new PassThrough();
    const outCapture = captureStream(false);
    const errCapture = captureStream(true);
    const prompt = createDefaultConsentPrompt({
      stdin,
      stdout: outCapture.stream as unknown as NodeJS.WritableStream,
      stderr: errCapture.stream as unknown as NodeJS.WritableStream,
    });
    const pending = prompt({ destination: "http://127.0.0.1:1", preview: PREVIEW });
    stdin.write("n\n");
    expect(await pending).toBe(false);
    expect(outCapture.chunks.join("")).toBe("");
  });

  it("grants on uppercase 'YES' (case-insensitive) with no STDOUT writes", async () => {
    const stdin = new PassThrough();
    const outCapture = captureStream(false);
    const errCapture = captureStream(true);
    const prompt = createDefaultConsentPrompt({
      stdin,
      stdout: outCapture.stream as unknown as NodeJS.WritableStream,
      stderr: errCapture.stream as unknown as NodeJS.WritableStream,
    });
    const pending = prompt({ destination: "http://127.0.0.1:1", preview: PREVIEW });
    stdin.write("YES\n");
    expect(await pending).toBe(true);
    expect(outCapture.chunks.join("")).toBe("");
  });
});
