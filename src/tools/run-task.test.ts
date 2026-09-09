import { test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "./run-task.js";
import type { LocallyConfig } from "../config.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-rtask-")));
mkdirSync(join(base, "src"));
writeFileSync(join(base, "src", "app.ts"), "export const x = 1;\n");

const config: LocallyConfig = {
  default: { baseUrl: "http://endpoint/v1", model: "test-model", apiKey: "" },
  allowedRoots: [base],
};

afterEach(() => vi.unstubAllGlobals());

/** Run one turn and hand back the system message that reached the endpoint. */
async function systemPromptFor(params: Parameters<typeof runTask>[1] = { task: "q", path: base }) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: "done" } }], usage: {} }),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  await runTask(config, params);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  const messages = JSON.parse(init.body).messages as { role: string; content: string }[];
  return messages.find((m) => m.role === "system")?.content;
}

test("run_task sends a contract at all", async () => {
  // It sent no system message until the contract existed: runAgenticTask composes
  // `agentConfig.systemPrompt ?? baseSystemPrompt`, and only explore_task supplied one.
  const system = await systemPromptFor();
  expect(system).toBeDefined();
  expect(system).toContain("You do the task, and then you stop");
});

test("the contract names the markdown fence, which lands in the file rather than in chat", async () => {
  const system = await systemPromptFor();
  expect(system).toContain("Never put a markdown fence around the content");
  expect(system).toContain("Never write a comment about your own work into the file");
});

test("the contract bars the redesign nobody asked for", async () => {
  const system = await systemPromptFor();
  expect(system).toContain("Do not review the code");
  expect(system).toContain("Do not propose a redesign");
});

test("the contract tells the model to read a file before patching it", async () => {
  // patch_file matches on exact text, so a patch written from the directory map alone fails.
  expect(await systemPromptFor()).toContain("Read a file before you patch it");
});

test("the caller's system_prompt is added to the contract, not swapped for it", async () => {
  const system = await systemPromptFor({ task: "q", path: base, system_prompt: "House rule: tabs." });
  expect(system).toContain("You do the task, and then you stop");
  expect(system).toContain("House rule: tabs.");
});

test("an agent's own systemPrompt replaces the contract", async () => {
  // A model fine-tuned against a fixed harness wants that harness, not ours plus that harness
  // (agentic-task.ts). The contract must not be stacked underneath it.
  const configured: LocallyConfig = {
    ...config,
    default: { ...config.default, systemPrompt: "You are a fine-tuned writer." },
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: "done" } }], usage: {} }),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  await runTask(configured, { task: "q", path: base });
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  const messages = JSON.parse(init.body).messages as { role: string; content: string }[];
  const system = messages.find((m) => m.role === "system")?.content;
  expect(system).toBe("You are a fine-tuned writer.");
  expect(system).not.toContain("You do the task, and then you stop");
});
