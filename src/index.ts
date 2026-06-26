import { loadConfig, resolveTransportMode } from "./config.js";
import { startStdio } from "./transport/stdio.js";
import { startHttp } from "./transport/http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = resolveTransportMode(config);

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
