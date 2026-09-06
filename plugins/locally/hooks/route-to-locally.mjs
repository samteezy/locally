#!/usr/bin/env node
// PreToolUse gate. Sends the two tool calls that cost the most context to locally instead:
// a full read of a large file, and a repo-wide Grep. Both denials name a way back to the
// native tool, so a wrong call from this hook costs one turn rather than blocking the session.
//
// Node rather than bash + jq: the plugin already needs Node to run `npx locally-mcp`, so this
// adds no dependency and works the same on Windows.
import { readFileSync, statSync } from "node:fs";

const DEFAULT_MAX_LINES = 400;
// Read renders these itself. A local model cannot answer questions about them from a grep,
// so a denial here would just cost a turn.
const NON_TEXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
  ".pdf", ".ipynb", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf",
]);
// Above this, count no lines — the file is large by any threshold.
const HUGE_BYTES = 2_000_000;

const off = (name) => process.env[name] === "0";
const on = (name) => process.env[name] === "1";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function allow(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// No output and exit 0 leaves the normal permission flow alone. Every path that is not a
// deliberate decision ends here, so a failure in this hook cannot block a tool call.
function pass() {
  process.exit(0);
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function maxLines() {
  const raw = Number(process.env.LOCALLY_READ_MAX_LINES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_LINES;
}

function countLines(path) {
  const text = readFileSync(path, "utf-8");
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  // A last line with no trailing newline still counts, which is what `wc -l` does not do.
  return text.charCodeAt(text.length - 1) === 10 ? lines : lines + 1;
}

function gateRead(input) {
  const { file_path: filePath, offset, limit } = input;
  // A targeted read is the answer this hook asks for. Never block one.
  if (offset !== undefined || limit !== undefined) pass();
  if (typeof filePath !== "string" || filePath.length === 0) pass();

  const dot = filePath.lastIndexOf(".");
  if (dot > -1 && NON_TEXT.has(filePath.slice(dot).toLowerCase())) pass();

  let size;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) pass();
    size = stat.size;
  } catch {
    pass(); // Missing file. Let Read report the error.
  }

  const threshold = maxLines();
  let lines;
  if (size > HUGE_BYTES) {
    lines = `over ${Math.round(size / 1000)}k bytes of`;
  } else {
    try {
      const counted = countLines(filePath);
      if (counted <= threshold) pass();
      lines = `${counted}`;
    } catch {
      pass(); // Unreadable or binary. Let Read report it.
    }
  }

  deny(
    `This file is ${lines} lines. The limit is ${threshold} lines. ` +
      `Do not read all of it into context. Do one of these instead:\n` +
      `1. Ask mcp__locally__explore_task a question about the file. Pass the file path in "path".\n` +
      `2. Read the file again with "offset" and "limit" for the part that you need.\n` +
      `Choose option 2 when you must have the exact text for an edit. ` +
      `Choose option 2 also when mcp__locally__explore_task is not connected. ` +
      `Set LOCALLY_READ_MAX_LINES to raise the limit, or LOCALLY_HOOK_READ=0 to turn this check off.`
  );
}

function gateGrep(input) {
  // A narrowed search is cheap. Only the repo-wide sweep goes to locally.
  if (input.glob || input.type) pass();
  if (input.output_mode === "count") pass();
  if (typeof input.path === "string" && input.path.length > 0) {
    try {
      if (statSync(input.path).isFile()) pass();
    } catch {
      pass();
    }
  }

  deny(
    `This search has no "glob" filter and no "type" filter. It sweeps the whole tree. ` +
      `Do one of these instead:\n` +
      `1. Ask mcp__locally__explore_task what you want to find. It searches and reads, ` +
      `and it returns file:line citations. Set breadth to "very thorough" for a wide sweep.\n` +
      `2. Run Grep again with a "glob" or a "type" filter, or with "path" set to one file.\n` +
      `Choose option 2 when you must have the raw matches. ` +
      `Choose option 2 also when mcp__locally__explore_task is not connected. ` +
      `Set LOCALLY_HOOK_GREP=0 to turn this check off.`
  );
}

const input = readStdin();
if (input === null) pass();

const tool = input.tool_name;
const args = input.tool_input ?? {};

if (tool === "Read") {
  if (off("LOCALLY_HOOK_READ")) pass();
  gateRead(args);
} else if (tool === "Grep") {
  // Opt-in. The Read gate blocks a call that is nearly always wasteful. This one blocks a
  // search that is often the right call, so it is off until the operator asks for it.
  if (!on("LOCALLY_HOOK_GREP")) pass();
  gateGrep(args);
} else if (tool === "mcp__locally__explore_task" || tool === "mcp__locally__usage_report") {
  // A plugin cannot ship a permissions allowlist, so the allow decision is made here.
  // Both tools are read-only and fenced to allowedRoots. run_task writes files and runs
  // shell commands, so it is left to the normal permission prompt on purpose.
  if (off("LOCALLY_HOOK_ALLOW")) pass();
  allow("Read-only locally tool, auto-approved by the locally plugin.");
}

pass();
