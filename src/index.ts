import { loadConfig, resolveTransportMode, symbolCheckEnabled } from "./config.js";
import { LocallyError } from "./llm/errors.js";
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

  // Surfaced for the same reason as the fence: a check that is silently off is worse than one
  // that is loudly off, and this one only speaks up when it finds something.
  if (!symbolCheckEnabled()) {
    process.stderr.write("locally: explore_task symbol check disabled (LOCALLY_VERIFY_SYMBOLS)\n");
  }

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
  // A startup LocallyError carries the one concrete next step; on stderr that is the whole value of
  // the failure, and dropping it leaves the operator with a complaint and no remedy.
  if (err instanceof LocallyError) {
    process.stderr.write(`Fix: ${err.fix}\n`);
  }
  process.exit(1);
});
