import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // sqlite-vec resolves its prebuilt binary relative to its own location, so it must stay
  // external (bundling would break getLoadablePath()). node:sqlite is loaded via a runtime
  // require in store.ts (esbuild would otherwise rewrite the import to an unresolvable "sqlite").
  external: ["@modelcontextprotocol/sdk", "sqlite-vec"],
});
