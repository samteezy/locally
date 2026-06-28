import { loadConfig, resolveTransportMode } from "./config.js";
import { effectiveRoots } from "./tools/sandbox.js";
import { startStdio } from "./transport/stdio.js";
import { startHttp } from "./transport/http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = resolveTransportMode(config);

  // Surface the filesystem fence the model runs inside. Resolving here also fails fast on a
  // misconfigured allowedRoots, and makes it obvious whether the default process.cwd() landed
  // where you expect (it's the directory the MCP client launched this server in).
  const roots = effectiveRoots(config);
  const fence = config.allowedRoots?.length ? "allowedRoots" : "default (launch directory)";
  process.stderr.write(`locally: file/shell tools confined to [${fence}]: ${roots.join(", ")}\n`);

  if (mode === "http") {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
