import { test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exploreTask } from "./explore-task.js";
import type { LocallyConfig } from "../config.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-etask-")));
mkdirSync(join(base, "src"));
writeFileSync(join(base, "src", "app.ts"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));

const config: LocallyConfig = {
  default: { baseUrl: "http://endpoint/v1", model: "test-model", apiKey: "" },
  allowedRoots: [base],
};

afterEach(() => vi.unstubAllGlobals());

/** Stub a single completion turn: the model answers immediately with prose. */
function answerWith(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { content: text } }], usage: {} }),
      text: async () => "",
    }))
  );
}

test("confirms citations that resolve", async () => {
  answerWith("The handler is at src/app.ts:4.");
  const result = await exploreTask(config, { task: "where is the handler?", path: base });
  expect(result.text).toContain("1 citation checked");
  expect(result.text).toContain("all resolve");
});

test("flags a citation to a file that does not exist", async () => {
  answerWith("Registered in src/router.ts:88.");
  const result = await exploreTask(config, { task: "where is the router?", path: base });
  expect(result.text).toContain("did not resolve");
  expect(result.text).toContain("src/router.ts:88 (file not found)");
  expect(result.text).toContain("unverified");
});

test("flags a line past the end of a real file", async () => {
  answerWith("See src/app.ts:900.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("src/app.ts:900 (file has 12 lines)");
});

test("adds no citation note when the answer cites nothing", async () => {
  answerWith("I could not find it in src.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).not.toContain("Citations:");
});

test("a very thorough run that ends immediately is marked a shallow sweep", async () => {
  answerWith("Done.");
  const result = await exploreTask(config, { task: "q", path: base, breadth: "very thorough" });
  expect(result.text).toContain("Shallow sweep");
  expect(result.text).toContain("1 iteration");
});

test("medium breadth gets no shallow-sweep note", async () => {
  answerWith("Done.");
  const result = await exploreTask(config, { task: "q", path: base, breadth: "medium" });
  expect(result.text).not.toContain("Shallow sweep");
});

test("the seeded prompt frames the tree as a starting point and names the real fence", async () => {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    void init;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }),
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  await exploreTask(config, { task: "q", path: join(base, "src") });

  const [, init] = fetchMock.mock.calls[0];
  const body = JSON.parse(init.body);
  const user = body.messages.find((m: { role: string }) => m.role === "user").content;
  expect(user).toContain("not a boundary");
  expect(user).toContain(base);

  const system = body.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).toContain("Never state what a file contains unless you read it");
});
