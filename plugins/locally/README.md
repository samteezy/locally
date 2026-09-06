# locally (Claude Code plugin)

Packages the four things that make Claude Code actually delegate to
[locally](https://github.com/samteezy/locally) — the MCP server registration, a skill, a
subagent, and a PreToolUse gate — into one install.

Installing the MCP server only makes locally's tools *available*. Claude Code still does
low-stakes work itself with `Read` and `Grep` unless you steer it. `docs/claude-code.md` in
the main repo describes how to assemble that steering by hand; this plugin is the same
thing pre-assembled.

## Install

```bash
claude plugin marketplace add samteezy/locally
claude plugin install locally@locally
```

You'll be prompted for the endpoint base URL and the model name. Both feed the MCP server's
`LOCALLY_BASE_URL` / `LOCALLY_MODEL` environment variables. The server is launched with
`npx -y locally-mcp`, so there's nothing to build or clone.

If you already have a `locally.config.json`, set the **Config file** option to its path
instead — a config file replaces the prompted values entirely (see
[Config](https://github.com/samteezy/locally#config)). A `locally.config.json` in the
directory you launch Claude from is picked up on its own.

## What you get

| Component | Effect |
|---|---|
| MCP server `locally` | `explore_task`, `run_task`, `usage_report` are available with no `claude mcp add` |
| Skill `delegating-to-locally` | Tells Claude which tool to call and how far to trust the answer |
| Subagent `local-delegate` | `@agent-local-delegate` runs a task with *only* the locally tools |
| PreToolUse hook | Blocks a full read of a large file and a repo-wide `Grep`, pointing both at `explore_task` |

The hook also auto-approves `explore_task` and `usage_report` so delegation isn't prompted
every time. `run_task` is deliberately left to the normal permission prompt: it writes
files, patches them, and runs shell commands.

## The hook

One script, `hooks/route-to-locally.mjs`, on three `PreToolUse` matchers. It denies only
the two calls that cost the most context, and every denial names a way back to the native
tool — so a wrong call costs one turn, not the session.

**`Read`** is blocked when the file is over 400 lines *and* the call has no `offset` or
`limit`. Targeted reads, small files, missing files, and non-text files (images, PDFs,
notebooks) always pass.

**`Grep`** is blocked when the search has no `glob` and no `type` filter — i.e. a sweep of
the whole tree or a whole subtree. Adding either filter, or pointing `path` at a single
file, passes. `output_mode: "count"` passes.

Both messages tell Claude to fall back to a targeted read or a narrowed grep when
`explore_task` isn't connected, so the plugin degrades gracefully if the server is down.

### Configuration

Plugins can't ship `permissions` or settings, so these are environment variables. Put them
in the `env` block of `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

| Variable | Default | Purpose |
|---|---|---|
| `LOCALLY_READ_MAX_LINES` | `400` | Line count above which a full `Read` is blocked |
| `LOCALLY_HOOK_READ` | on | Set to `0` to disable the `Read` gate |
| `LOCALLY_HOOK_GREP` | on | Set to `0` to disable the `Grep` gate |
| `LOCALLY_HOOK_ALLOW` | on | Set to `0` to stop auto-approving the read-only locally tools |

The `Grep` gate is the aggressive one. If it fires more than it helps in your repo, turn it
off and keep the `Read` gate.

## What doesn't get delegated

- **Review, audits, severity calls** — `explore_task` reports what and where by design; it
  won't give a verdict.
- **Tricky debugging** — needs the frontier model's reasoning, not a summary.
- **Edits needing exact content** — read the section with `offset`/`limit` instead.
- **Anything the model had to derive** — a default value, a resolution order, an exhaustive
  count, a rule about what runs when. Check those against source. They're where locally's
  hard errors live.

## Requirements

- Node ≥ 24 (for `npx locally-mcp` and the hook script)
- An OpenAI-compatible endpoint serving a local model — Ollama, llama.cpp, LM Studio, vLLM
