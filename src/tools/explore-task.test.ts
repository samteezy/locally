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
  expect(result.text).toContain("names a file that does not exist");
  expect(result.text).toContain("src/router.ts:88");
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
  expect(result.text).toContain("Citations: **none parsed**");
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
  // A right list of tables generated a wrong list of one-schema-file-per-table (issue #16), so the
  // prompt names that specific move rather than repeating the general "do not describe what you
  // did not read" rule.
  expect(system).toContain("Before naming a SET of files");
});

test("a very thorough run that ends immediately is marked a shallow sweep", async () => {
  answerWith("Done.");
  const result = await exploreTask(config, { task: "q", path: base, breadth: "very thorough" });
  expect(result.text).toContain("Shallow sweep");
  // Two iterations, not one: it was asked to keep sweeping and repeated its answer instead.
  expect(result.text).toContain("2 iterations");
  expect(result.text).toContain("asked to keep sweeping");
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

// --- breadth shapes the loop ---------------------------------------------------
// A "very thorough" run that spent 5 of 20 iterations and read 5 files, against a repository where
// a "medium" run read 8, is what issue #16 measured. Breadth was prompt flavouring and a ceiling.

/** Replay a fixed list of assistant turns, one per completion call. */
function replay(turns: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    void init;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: turns[Math.min(call++, turns.length - 1)] }], usage: {} }),
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("a thin very-thorough run is asked to keep sweeping", async () => {
  const fetchMock = replay([{ content: "Done." }, { content: "Done, having also checked src/app.ts:4." }]);
  const result = await exploreTask(config, { task: "q", path: base, breadth: "very thorough" });

  const lastBody = JSON.parse(fetchMock.mock.calls[1][1].body);
  const nudge = lastBody.messages[lastBody.messages.length - 1];
  expect(nudge.role).toBe("user");
  expect(nudge.content).toContain("not yet a thorough sweep");
  expect(nudge.content).toContain("do not pad it");
  expect(result.nudged).toBe(true);
});

test("the nudge fires at most once", async () => {
  const fetchMock = replay([{ content: "Done." }]);
  await exploreTask(config, { task: "q", path: base, breadth: "very thorough" });
  // Two completions: the first answer, the nudge, and then the repeat is accepted.
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("medium breadth is never nudged", async () => {
  const fetchMock = replay([{ content: "Done." }]);
  const result = await exploreTask(config, { task: "q", path: base, breadth: "medium" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.nudged).toBe(false);
});

test("a caller who caps the run short is not nudged", async () => {
  // max_iterations is the caller saying how much sweeping they want; do not overrule it.
  const fetchMock = replay([{ content: "Done." }]);
  await exploreTask(config, { task: "q", path: base, breadth: "very thorough", max_iterations: 3 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// --- the negative-result affordance --------------------------------------------
// Run A described 7 schema files it never opened. Those did not exist and the Files: check catches
// them; this catches the other half — real files described without being looked at.

test("names real files the run described without opening", async () => {
  answerWith("The handler is at src/app.ts:4.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("Coverage:");
  expect(result.text).toContain("Described without being looked at: `src/app.ts`");
});

test("says nothing when every named file was read", async () => {
  const result = await (async () => {
    replay([
      {
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: join(base, "src/app.ts") }) },
          },
        ],
      },
      { content: "The handler is at src/app.ts:4." },
    ]);
    return exploreTask(config, { task: "q", path: base });
  })();
  expect(result.text).not.toContain("Coverage:");
});

test("a file matched in a search counts as looked at", async () => {
  // The contract accepts a search hit as evidence, so counting only read_file would flag the
  // tool's own recommended workflow as unevidenced.
  replay([
    {
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "explore_files",
            arguments: JSON.stringify({ path: join(base, "src"), query: "line 4" }),
          },
        },
      ],
    },
    { content: "The handler is at src/app.ts:4." },
  ]);
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).not.toContain("Coverage:");
});

// --- invented file paths --------------------------------------------------------

test("flags a file path the answer names but the tree does not hold", async () => {
  answerWith("Each table has a schema: `schemas/document.ts`. See src/app.ts:4.");
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("does not exist anywhere in the tree");
  expect(result.text).toContain("`schemas/document.ts`");
});

test("LOCALLY_VERIFY_SYMBOLS=0 turns the file-path check off too", async () => {
  const original = process.env.LOCALLY_VERIFY_SYMBOLS;
  process.env.LOCALLY_VERIFY_SYMBOLS = "0";
  try {
    answerWith("Each table has a schema: `schemas/document.ts`. See src/app.ts:4.");
    const result = await exploreTask(config, { task: "q", path: base });
    expect(result.text).not.toContain("Files:");
  } finally {
    if (original === undefined) delete process.env.LOCALLY_VERIFY_SYMBOLS;
    else process.env.LOCALLY_VERIFY_SYMBOLS = original;
  }
});

test("a file named after a directory listing is not called undescribed", async () => {
  // Issue #16 run B was a correct inventory of three directories. A listing settles "this file
  // exists", which is the whole claim an inventory makes.
  replay([
    {
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "explore_files", arguments: JSON.stringify({ path: join(base, "src") }) },
        },
      ],
    },
    { content: "The directory holds `app.ts`." },
  ]);
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).not.toContain("Coverage:");
});

test("a listing does not license a claim about a line's contents", async () => {
  // Seeing the name is not seeing the line. The stricter requirement wins when a file is both
  // cited and merely named.
  replay([
    {
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "explore_files", arguments: JSON.stringify({ path: join(base, "src") }) },
        },
      ],
    },
    { content: "The handler is at src/app.ts:4, in `app.ts`." },
  ]);
  const result = await exploreTask(config, { task: "q", path: base });
  expect(result.text).toContain("Described without being looked at: `src/app.ts`");
});
