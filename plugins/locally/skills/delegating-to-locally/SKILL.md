---
name: delegating-to-locally
description: "Delegate codebase exploration and routine writing to a local model through the locally MCP server. Use it to find code, to draft commit messages, changelog entries, boilerplate or scaffolding, and to make routine edits."
---

# Delegating to locally

The locally MCP server runs a smaller model on a local endpoint. Send low-stakes work to it.
Keep that work off the frontier model. Read every result before you rely on it.

## Which tool to call

| Task | Tool |
|------|------|
| Find code. Answer what and where. | `mcp__locally__explore_task` |
| Draft text. Write boilerplate. Make a routine edit. | `mcp__locally__run_task` |
| Report the work sent to locally. | `mcp__locally__usage_report` |

Pass the directory to start from in `path`. The model gets a map of that tree.
The path is a start point, not a boundary.

Set `breadth` to `very thorough` on `explore_task` for a wide sweep. The default is `medium`.

## How much to trust the answer

Route by how checkable the answer is. Do not route by topic.

- **Trust it** for a name, a path, a line number, or the set of files that match a pattern.
  This is what it does reliably well.
- **Expect gaps** for "how does this work". The answer is correct, but it can stop before
  the end of the call path.
- **Check it against the source** for an answer that the model had to derive. A default
  value, an order of precedence, a complete count, and a rule about what runs when are its
  characteristic failures.

Each result ends with a footer that names the model and the token counts. If you do not see
the footer, the work did not run locally.

`explore_task` reports what the code does and where it is. It does not review, audit, rate,
or recommend. Keep review, audits, severity calls, tricky debugging, high-stakes edits, and
design decisions on the frontier model.

## When the hook blocks a tool call

The plugin blocks a full read of a large file. The operator can also turn on a block for a
Grep with no `glob` filter and no `type` filter. Send the question to `explore_task`. If you
must have the exact text, read the file again with `offset` and `limit`. To search again,
add a `glob` filter or a `type` filter.
