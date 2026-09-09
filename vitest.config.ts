import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Tests must never touch the real network or real HOME state.
    passWithNoTests: false,
  },
});
