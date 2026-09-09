import { describe, expect, it } from "vitest";
import { RYF_VERSION } from "../src/shared/version.js";

describe("toolchain bootstrap", () => {
  it("vitest executes and resolves a src/shared module", () => {
    expect(RYF_VERSION).toBe("0.1.7");
  });

  it("runs trivial pure assertions", () => {
    expect(1 + 1).toBe(2);
  });
});
