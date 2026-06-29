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
      // the test files themselves, and root config.
      exclude: ["src/index.ts", "src/transport/**", "src/**/*.test.ts", "*.config.ts"],
    },
  },
});
