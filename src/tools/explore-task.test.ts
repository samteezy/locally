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

test("an answer with no citations at all is flagged as unanchored", async () => {
  answerWith("I could not find it in src.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("Citations: **none**");
});

test("counts the distinct files the model actually opened", async () => {
  // Two turns: the model reads one file twice under different spellings, then answers. The
  // footer figure should be 1 — it is a count of files, not of read_file calls.
  const turns = [
    {
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: join(base, "src/app.ts") }) },
        },
        {
          id: "c2",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: join(base, "src/../src/app.ts") }) },
        },
      ],
    },
    { content: "Answered from src/app.ts:4." },
  ];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: turns[call++] }], usage: {} }),
      text: async () => "",
    }))
  );

  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.filesRead).toBe(1);
});

test("flags a name the answer asserts but the tree does not contain", async () => {
  answerWith("The report lives in table `rka_corpus_reports`, see src/app.ts:4.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("does not appear anywhere in the tree");
  expect(result.text).toContain("`rka_corpus_reports`");
});

test("says nothing about symbols when every name resolves", async () => {
  answerWith("Defined at src/app.ts:4 as `line_marker`.");
  writeFileSync(join(base, "src", "marker.ts"), "const line_marker = 1;\n");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).not.toContain("Symbols:");
});

test("LOCALLY_VERIFY_SYMBOLS=0 turns the symbol check off", async () => {
  const original = process.env.LOCALLY_VERIFY_SYMBOLS;
  process.env.LOCALLY_VERIFY_SYMBOLS = "0";
  try {
    answerWith("The report lives in table `rka_corpus_reports`, see src/app.ts:4.");
    const result = await exploreTask(config, { task: "q", path: base });
    expect(result.text).not.toContain("Symbols:");
    // The citation check is unaffected — the switch is scoped to one check, not to verification.
    expect(result.text).toContain("1 citation checked");
  } finally {
    if (original === undefined) delete process.env.LOCALLY_VERIFY_SYMBOLS;
    else process.env.LOCALLY_VERIFY_SYMBOLS = original;
  }
});

test("the prompt asks the model to separate what it read from what it inferred", async () => {
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

  await exploreTask(config, { task: "q", path: base });

  const [, init] = fetchMock.mock.calls[0];
  const system = JSON.parse(init.body).messages.find((m: { role: string }) => m.role === "system").content;
  // Only the *unverified* claims carry a marker. Asking the model to also stamp the verified
  // ones gave it a label it could apply globally, and a 9B model duly closed one eval run with
  // a single blanket "every claim above is CONFIRMED" — an unearned confidence marker over an
  // answer nobody had checked. A tier that only ever admits doubt cannot be blanket-applied.
  expect(system).toContain("LIKELY:");
  expect(system).not.toContain("CONFIRMED");
  expect(system).toContain("never rate the answer as a whole");
  expect(system).toContain("may be incomplete");
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
