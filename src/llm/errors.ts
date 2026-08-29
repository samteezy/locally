/**
 * Categorized failures surfaced back to the calling (frontier) agent.
 *
 * The point of the category is to let the caller decide what to do without parsing prose:
 * - `timeout` / `constraint` — a configurable limit on locally's side; the caller can raise it and retry.
 * - `config` — a misconfiguration on locally's side; needs a config/env fix, then a reconnect.
 * - `upstream` — the model endpoint itself failed; not locally's fault.
 * - `cancelled` — the caller stopped the task (an MCP `tools/call` cancellation, or the client
 *   disconnecting). Nothing failed; there is nothing to fix.
 *
 * `origin` records whose fault it is ("local" = locally's config/limits, "upstream" = the endpoint),
 * and `fix` carries the one concrete, actionable next step. `formatLocallyError` renders all of this
 * as tagged prose so it reads cleanly in an MCP `isError` tool result.
 */
export type LocallyErrorCategory = "timeout" | "config" | "upstream" | "constraint" | "cancelled";

export interface LocallyErrorOptions {
  category: LocallyErrorCategory;
  origin: "local" | "upstream";
  retriable: boolean;
  /** The single concrete next step the caller should take. */
  fix: string;
}

export class LocallyError extends Error {
  readonly category: LocallyErrorCategory;
  readonly origin: "local" | "upstream";
  readonly retriable: boolean;
  readonly fix: string;

  constructor(message: string, opts: LocallyErrorOptions) {
    super(message);
    this.name = "LocallyError";
    this.category = opts.category;
    this.origin = opts.origin;
    this.retriable = opts.retriable;
    this.fix = opts.fix;
  }
}

/**
 * Render any thrown value as a tagged-prose block for the MCP tool result. A `LocallyError`
 * keeps its category/origin and fix; anything else is reported as an unexpected internal error
 * so the caller can still tell it apart from a known failure mode.
 */
export function formatLocallyError(err: unknown): string {
  if (err instanceof LocallyError) {
    const retriable = err.retriable ? " · retriable" : "";
    return `[locally error: ${err.category} — ${err.origin}${retriable}]\n${err.message}\nFix: ${err.fix}`;
  }

  const message = err instanceof Error ? err.message : String(err);
  return `[locally error: internal — local]\n${message}\nFix: this is an unexpected error inside locally. Check the server logs and retry.`;
}
