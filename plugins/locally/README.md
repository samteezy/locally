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

> [!IMPORTANT]
> **A config file on disk wins, and the prompted values are then ignored.** The server looks
> for `LOCALLY_CONFIG`, then `./locally.config.json`, then `~/.locally/config.json`, and
> returns the first one it finds. The `LOCALLY_BASE_URL` / `LOCALLY_MODEL` env fallbacks the
> prompts set are only consulted when *none* of those exists. So if you already keep a
> `locally.config.json`, leave the prompts blank and set the **Config file** option to its
> path — or just let the file in your working directory be found. See
> [Config](https://github.com/samteezy/locally#config).

## What you get

| Component | Effect |
|---|---|
| MCP server `locally` | `explore_task`, `run_task`, `usage_report` are available with no `claude mcp add` |
| Skill `delegating-to-locally` | Tells Claude which tool to call and how far to trust the answer |
| Subagent `local-delegate` | `@agent-local-delegate` runs a task with *only* the locally tools |
| PreToolUse hook | Blocks a full read of a large file, pointing it at `explore_task`. An opt-in `Grep` gate does the same for repo-wide searches. |

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

**`Grep`** is **off by default.** Set `LOCALLY_HOOK_GREP=1` to turn it on. It then blocks a
search with no `glob` and no `type` filter — a sweep of the whole tree or of a whole
subtree. Adding either filter, or pointing `path` at a single file, passes.
`output_mode: "count"` passes.

The asymmetry is deliberate. A full read of a 3,000-line file is nearly always wasteful, so
that gate ships on. A broad `Grep` is often the right call, and gating it fires many times a
session — so it stays off until you ask for it.

Both messages tell Claude to fall back to a targeted read or a narrowed grep when
`explore_task` isn't connected, so the plugin degrades gracefully if the server is down.

### Configuration

Plugins can't ship `permissions` or settings, so these are environment variables. Put them
in the `env` block of `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

| Variable | Default | Purpose |
|---|---|---|
| `LOCALLY_READ_MAX_LINES` | `400` | Line count above which a full `Read` is blocked |
| `LOCALLY_HOOK_READ` | on | Set to `0` to disable the `Read` gate |
| `LOCALLY_HOOK_GREP` | **off** | Set to `1` to enable the `Grep` gate |
| `LOCALLY_HOOK_ALLOW` | on | Set to `0` to stop auto-approving the read-only locally tools |

Turn the `Grep` gate on if you want exploration pushed to `explore_task` as a rule rather
than a preference. Expect it to fire often.

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
