import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // Edges that aren't unit-testable: the CLI entry, transport wiring,
      // the test files themselves, and root config. Named file by file rather than as
      // `src/transport/**`, so a testable module living next to the wiring (auth.ts) still counts.
      exclude: [
        "src/index.ts",
        "src/transport/http.ts",
        "src/transport/stdio.ts",
        "src/**/*.test.ts",
        "*.config.ts",
      ],
    },
  },
});
