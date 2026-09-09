/**
 * stderr progress reporter (progress-live Unit A, task 1.6).
 *
 * Wired only in `main` (the CLI entry owns process.stderr); injected into
 * runRyf so tests capture lifecycle events without real stderr I/O.
 *
 * - TTY: a live per-file session bar showing actual processed/total counts with
 *   stage redraws; the async backend-wait spinner shows real animated frames,
 *   elapsed time, and names the endpoint.
 * - nonTTY: at most one concise, deduplicated milestone line per stage.
 * - The "Preparing analysis" stage is emitted BEFORE the synchronous digest
 *   build; it MUST NOT render a timer or fraction that it cannot update (the
 *   event loop is blocked there).
 * - finish() prints the success "done" milestone; abort() cleans up with failure
 *   wording (never "done") for incomplete/error/aborted runs. Both leave no
 *   partial bar or cursor artifacts and always remove the registered signal
 *   listeners (no listener leaks).
 */

export interface ProgressReporter {
  /** Emit a stage marker (deduplicated on nonTTY). */
  stage(name: string): void;
  /** Per-file parser progress tick (processed/total). */
  onProgress(processed: number, total: number): void;
  /** Begin the async backend-wait spinner, naming the endpoint. */
  waitingFor(endpoint: string): void;
  /** End the async backend-wait spinner. */
  waitingDone(): void;
  /** Clean up after a SUCCESSFUL run (prints the "done" milestone). */
  finish(): void;
  /** Clean up after an incomplete/error/aborted run (failure wording, no "done"). */
  abort(): void;
}

export interface ProgressReporterOptions {
  /** Stream the reporter writes to (process.stderr, or a fake in tests). */
  stream: { write(chunk: string): boolean; isTTY?: boolean };
  /** Register SIGINT/SIGTERM cleanup handlers (CLI direct run only). */
  wireSignals?: boolean;
}

const STAGE_PREFIX = "ryf: ";
const BAR_WIDTH = 20;
const SPINNER = ["|", "/", "-", "\\"];

/** Render an ASCII bar (a TTY-only affordance). */
function renderBar(processed: number, total: number): string {
  const filled = total > 0 ? Math.round((processed / total) * BAR_WIDTH) : 0;
  return `[${"=".repeat(filled)}${" ".repeat(BAR_WIDTH - filled)}]`;
}

export function createProgressReporter(opts: ProgressReporterOptions): ProgressReporter {
  const { stream } = opts;
  const isTTY = stream.isTTY === true;
  const stageNames = new Set<string>();
  let currentLine = "";
  let waitTimer: ReturnType<typeof setInterval> | undefined;
  let waitStart = 0;
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  const clearLine = (): void => {
    if (isTTY && currentLine !== "") {
      stream.write("\r\x1b[2K");
      currentLine = "";
    }
  };

  const removeSignalListeners = (): void => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.length = 0;
  };

  const stopWaitTimer = (): void => {
    if (waitTimer !== undefined) {
      clearInterval(waitTimer);
      waitTimer = undefined;
    }
  };

  const finish = (): void => {
    stopWaitTimer();
    clearLine();
    stream.write(`${STAGE_PREFIX}done\n`);
    removeSignalListeners();
  };

  const abort = (): void => {
    stopWaitTimer();
    const hadLine = currentLine !== "";
    clearLine(); // clears the live "Preparing analysis" line (works: currentLine was set)
    if (hadLine) {
      // Failure wording for an incomplete/error/aborted run (never success "done").
      stream.write(`${STAGE_PREFIX}analysis not completed\n`);
    }
    removeSignalListeners();
  };

  const stage = (name: string): void => {
    if (!isTTY) {
      if (stageNames.has(name)) {
        return; // deduplicated milestone: at most one line per stage
      }
      stageNames.add(name);
      stream.write(`${STAGE_PREFIX}${name}\n`);
      return;
    }
    const line = `${STAGE_PREFIX}${name}`;
    stream.write(`\r\x1b[2K${line}`);
    currentLine = line;
  };

  const onProgress = (processed: number, total: number): void => {
    if (!isTTY) {
      return; // nonTTY never spams per-file lines
    }
    const line = `${STAGE_PREFIX}Parsing sessions ${renderBar(processed, total)} ${processed}/${total}`;
    stream.write(`\r\x1b[2K${line}`);
    currentLine = line;
  };

  const waitingFor = (endpoint: string): void => {
    if (!isTTY) {
      stream.write(`${STAGE_PREFIX}Waiting for ${endpoint}…\n`);
      return;
    }
    stopWaitTimer(); // never stack/leak a prior timer
    waitStart = Date.now();
    let frame = 0;
    const render = (): void => {
      const elapsed = ((Date.now() - waitStart) / 1000).toFixed(1);
      const spin = SPINNER[frame % SPINNER.length];
      frame += 1;
      const line = `${STAGE_PREFIX}Waiting for ${endpoint}… ${spin} ${elapsed}s`;
      stream.write(`\r\x1b[2K${line}`);
      currentLine = line;
    };
    render();
    waitTimer = setInterval(render, 120);
  };

  const waitingDone = (): void => {
    stopWaitTimer();
    clearLine();
  };

  if (opts.wireSignals === true) {
    const onSigInt = (): void => {
      abort();
      process.exit(130);
    };
    const onSigTerm = (): void => {
      abort();
      process.exit(143);
    };
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    signalHandlers.push(["SIGINT", onSigInt], ["SIGTERM", onSigTerm]);
  }

  return { stage, onProgress, waitingFor, waitingDone, finish, abort };
}
