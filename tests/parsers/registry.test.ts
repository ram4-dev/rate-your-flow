import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getParser, UnknownSourceError } from "../../src/cli/parsers/registry.js";

const PI_FIXTURE = (): string =>
  fileURLToPath(new URL("../fixtures/parsers/pi/valid.jsonl", import.meta.url));

describe("parser registry", () => {
  it("returns the codex@1 parser for its source tag", () => {
    const parser = getParser("codex@1");
    expect(typeof parser).toBe("function");
  });

  it("registers pi@1 as an implemented async parser (promise contract)", async () => {
    const parser = getParser("pi@1");
    expect(typeof parser).toBe("function");
    const session = await parser(PI_FIXTURE());
    expect(session.sourceVersion).toBe("pi@1");
    expect(session.sessionId).toBe("sess-pi-001");
  });

  it("throws a typed error for unknown sources", () => {
    expect(() => getParser("claude@9")).toThrow(UnknownSourceError);
    expect(() => getParser("")).toThrow(UnknownSourceError);
  });
});
