import type { AgentRunResult } from "./llm/agent-loop.js";

// Process-level counters for work the local model has done. They survive across
// tool calls but reset when the process restarts. In stdio mode the process
// serves one client, so this is a per-session total; in HTTP mode it spans all
// clients, so usage_report labels it "since server start" rather than "session".
let completionTokens = 0;
let taskCount = 0;

export interface SessionStats {
  taskCount: number;
  completionTokens: number;
}

/** Reset counters. Exposed for tests. */
export function resetUsage(): void {
  completionTokens = 0;
  taskCount = 0;
}

export function getSessionStats(): SessionStats {
  return { taskCount, completionTokens };
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

/**
 * Record a completed run and return its text with a one-line provenance footer.
 * The footer tells the frontier model the work came from a smaller model and
 * how much it generated — the cumulative tally lives in the usage_report tool.
 */
export function withUsageFooter(result: AgentRunResult): string {
  completionTokens += result.completionTokens;
  taskCount += 1;

  const iterLabel = `${result.iterations} iter${result.iterations === 1 ? "" : "s"}`;
  const tokenPart =
    result.completionTokens > 0
      ? `~${fmtTokens(result.completionTokens)} tokens generated`
      : "token usage not reported by endpoint";

  return `${result.text}\n\n---\n_locally · ${result.model} · ${iterLabel} · ${tokenPart}_`;
}

/** One-line cumulative summary for the usage_report tool. */
export function formatUsageReport(): string {
  const { taskCount, completionTokens } = getSessionStats();
  if (taskCount === 0) {
    return "locally has not handled any tasks since this server started.";
  }
  const tasks = `${taskCount} task${taskCount === 1 ? "" : "s"}`;
  return `locally has handled ${tasks} since this server started, generating ~${fmtTokens(completionTokens)} tokens locally and keeping them off the frontier model.`;
}
