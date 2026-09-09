import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, beforeAll } from "vitest";

/**
 * The hook is a router: a tool call in, one of three answers out (deny / allow / stay
 * silent). Its dangerous failure is the silent one — a wrongly *passed* call breaks
 * nothing visibly, it just stops the plugin from doing anything. So the cases that matter
 * most here are the escape hatches (offset/limit, glob/type, the non-text list) and the
 * env switches, which are what a later edit is most likely to break while the obvious
 * paths keep working.
 *
 * The script is spawned rather than imported, so what is under test is the artifact
 * Claude Code actually runs, exit code included.
 */
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "route-to-locally.mjs");

interface HookResult {
  decision: "deny" | "allow" | "none";
  reason: string;
}

function run(toolName: string, toolInput: unknown, env: Record<string, string> = {}): HookResult {
  const stdout = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
    // A clean base, so an ambient LOCALLY_* in the developer's shell cannot flip a case.
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf-8",
  });
  if (stdout.trim() === "") return { decision: "none", reason: "" };
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: "deny" | "allow"; permissionDecisionReason: string };
  };
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

function runRaw(stdin: string): HookResult {
  const stdout = execFileSync("node", [HOOK], {
    input: stdin,
    env: { PATH: process.env["PATH"] ?? "" },
    encoding: "utf-8",
  });
  return stdout.trim() === "" ? { decision: "none", reason: "" } : { decision: "deny", reason: stdout };
}

let big: string;
let small: string;
let bigPng: string;
let dir: string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "locally-hook-"));
  big = join(root, "big.txt");
  small = join(root, "small.txt");
  bigPng = join(root, "big.png");
  dir = join(root, "subdir");
  // 500 lines, each newline-terminated.
  const body = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(big, body);
  writeFileSync(bigPng, body);
  writeFileSync(small, "one\ntwo\nthree\n");
  mkdirSync(dir);
});

// --- Read gate: on by default -----------------------------------------------

test("Read of a file over the limit is denied and points at explore_task", () => {
  const result = run("Read", { file_path: big });
  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("mcp__locally__explore_task");
  // The escape hatch must be in the message, or a denial costs more than one turn.
  expect(result.reason).toContain("offset");
});

test("the denied line count matches wc -l, with no off-by-one", () => {
  expect(run("Read", { file_path: big }).reason).toContain("500 lines");
});

test("a targeted read is never denied", () => {
  expect(run("Read", { file_path: big, offset: 1, limit: 50 }).decision).toBe("none");
  expect(run("Read", { file_path: big, limit: 50 }).decision).toBe("none");
  expect(run("Read", { file_path: big, offset: 400 }).decision).toBe("none");
});

test("a file under the limit passes", () => {
  expect(run("Read", { file_path: small }).decision).toBe("none");
});

test("a missing file passes, so Read reports the error itself", () => {
  expect(run("Read", { file_path: join(tmpdir(), "does-not-exist-9e3f.txt") }).decision).toBe("none");
});

test("a directory passes", () => {
  expect(run("Read", { file_path: dir }).decision).toBe("none");
});

test("a large non-text file passes, since a local model cannot answer from a grep", () => {
  expect(run("Read", { file_path: bigPng }).decision).toBe("none");
});

test("LOCALLY_READ_MAX_LINES moves the limit in both directions", () => {
  expect(run("Read", { file_path: big }, { LOCALLY_READ_MAX_LINES: "1000" }).decision).toBe("none");
  expect(run("Read", { file_path: small }, { LOCALLY_READ_MAX_LINES: "2" }).decision).toBe("deny");
});

test("a junk LOCALLY_READ_MAX_LINES falls back to the default rather than passing everything", () => {
  expect(run("Read", { file_path: big }, { LOCALLY_READ_MAX_LINES: "banana" }).decision).toBe("deny");
});

test("LOCALLY_HOOK_READ=0 turns the Read gate off", () => {
  expect(run("Read", { file_path: big }, { LOCALLY_HOOK_READ: "0" }).decision).toBe("none");
});

// --- Bash gate: the same read, spelled as a shell command --------------------

test("cat on a file over the limit is denied", () => {
  const result = run("Bash", { command: `cat ${big}` });
  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("mcp__locally__explore_task");
  expect(result.reason).toContain("head -n");
});

test("cat -n is a full read, not a line count", () => {
  // `-n` numbers the lines for cat and sets a count for head. Reading it as a count here
  // swallowed the filename and let the call through.
  expect(run("Bash", { command: `cat -n ${big}` }).decision).toBe("deny");
});

test("the pagers are gated like cat", () => {
  expect(run("Bash", { command: `less ${big}` }).decision).toBe("deny");
  expect(run("Bash", { command: `more ${big}` }).decision).toBe("deny");
});

test("head and tail are bounded reads and pass by default", () => {
  expect(run("Bash", { command: `head ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `tail ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `head -100 ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `head -n 50 ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `tail -n 20 ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `head --lines=50 ${big}` }).decision).toBe("none");
});

test("an explicit count over the limit is a full read wearing a flag", () => {
  expect(run("Bash", { command: `head -n 9999 ${big}` }).decision).toBe("deny");
  expect(run("Bash", { command: `head -5000 ${big}` }).decision).toBe("deny");
});

test("a byte-bounded read passes whatever the file's length", () => {
  expect(run("Bash", { command: `head -c 200 ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `head --bytes=200 ${big}` }).decision).toBe("none");
});

test("a pipe or a redirect is not a read into context", () => {
  expect(run("Bash", { command: `cat ${big} | grep foo` }).decision).toBe("none");
  expect(run("Bash", { command: `cat ${big} > /dev/null` }).decision).toBe("none");
});

test("cat under the limit, on a missing file, or on a directory passes", () => {
  expect(run("Bash", { command: `cat ${small}` }).decision).toBe("none");
  expect(run("Bash", { command: "cat /nonexistent-4b1f.txt" }).decision).toBe("none");
  expect(run("Bash", { command: `cat ${dir}` }).decision).toBe("none");
});

test("an ordinary command is untouched", () => {
  for (const command of ["git status", "npm test", "ls -la", "rg foo", "node -e \"1\""]) {
    expect(run("Bash", { command }).decision).toBe("none");
  }
});

test("LOCALLY_HOOK_BASH=0 turns the Bash gate off", () => {
  expect(run("Bash", { command: `cat ${big}` }, { LOCALLY_HOOK_BASH: "0" }).decision).toBe("none");
});

test("the shell parser fails open rather than guessing", () => {
  // Documented leaks. Each one raises the cost of the bypass without closing it, and each
  // must pass rather than deny on a misparse.
  expect(run("Bash", { command: `cd /tmp && cat ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: `sed -n '1,9999p' ${big}` }).decision).toBe("none");
  expect(run("Bash", { command: "cat" }).decision).toBe("none");
  expect(run("Bash", {}).decision).toBe("none");
});

// --- Grep gate: opt-in ------------------------------------------------------

test("the Grep gate is off unless the operator opts in", () => {
  expect(run("Grep", { pattern: "foo" }).decision).toBe("none");
  expect(run("Grep", { pattern: "foo" }, { LOCALLY_HOOK_GREP: "0" }).decision).toBe("none");
});

test("an unfiltered Grep is denied once the gate is on", () => {
  const result = run("Grep", { pattern: "foo" }, { LOCALLY_HOOK_GREP: "1" });
  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("mcp__locally__explore_task");
  expect(result.reason).toContain("glob");
});

test("a narrowed Grep passes with the gate on", () => {
  const on = { LOCALLY_HOOK_GREP: "1" };
  expect(run("Grep", { pattern: "foo", glob: "**/*.ts" }, on).decision).toBe("none");
  expect(run("Grep", { pattern: "foo", type: "ts" }, on).decision).toBe("none");
  expect(run("Grep", { pattern: "foo", path: big }, on).decision).toBe("none");
  expect(run("Grep", { pattern: "foo", output_mode: "count" }, on).decision).toBe("none");
});

test("a Grep scoped only to a directory is still a sweep", () => {
  expect(run("Grep", { pattern: "foo", path: dir }, { LOCALLY_HOOK_GREP: "1" }).decision).toBe("deny");
});

// --- The allow decision, which stands in for a permissions list -------------

test("the read-only locally tools are auto-approved", () => {
  expect(run("mcp__locally__explore_task", { task: "where is the loop" }).decision).toBe("allow");
  expect(run("mcp__locally__usage_report", {}).decision).toBe("allow");
});

test("run_task is never auto-approved, because it writes files and runs shell", () => {
  expect(run("mcp__locally__run_task", { task: "write a file" }).decision).toBe("none");
});

test("LOCALLY_HOOK_ALLOW=0 returns the locally tools to the permission prompt", () => {
  expect(run("mcp__locally__explore_task", { task: "x" }, { LOCALLY_HOOK_ALLOW: "0" }).decision).toBe("none");
});

// --- Failing open -----------------------------------------------------------

test("a tool the hook does not gate passes", () => {
  expect(run("Bash", { command: "ls" }).decision).toBe("none");
  expect(run("Edit", { file_path: big }).decision).toBe("none");
});

test("malformed input passes rather than blocking the call", () => {
  expect(runRaw("not json at all").decision).toBe("none");
  expect(runRaw("").decision).toBe("none");
  expect(run("Read", undefined).decision).toBe("none");
});
