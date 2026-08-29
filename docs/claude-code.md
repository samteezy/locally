# Getting Claude Code to use locally

Installing the `locally` MCP server makes its tools *available* to Claude Code — it
does not make Claude *use* them. By default Claude Code does low-stakes work itself
with its built-in tools (`Read`, `Grep`, `Glob`, `Edit`, `Bash`, …) and rarely
reaches for an MCP server's tools on its own. To actually keep that work off the
frontier model, you have to steer Claude toward `locally`.

The server does ship its own MCP instructions describing when to delegate and how
far to trust the result, so a client that surfaces them gets that much for free.
This guide covers the ways to push harder, from the lightest nudge to hard
enforcement. Start at the top and only go further down if you need to.

> `locally` exposes three tools. In Claude Code they're namespaced by the server
> name from your MCP config (`locally` in the README examples):
>
> | Tool | Reference in Claude Code | Use for |
> |------|--------------------------|---------|
> | `explore_task` | `mcp__locally__explore_task` | Read-only: finding code — names, paths, line numbers, pattern matches |
> | `run_task` | `mcp__locally__run_task` | Drafting and routine edits (commit messages, boilerplate, scaffolding) |
> | `usage_report` | `mcp__locally__usage_report` | Report how much work has been offloaded |
>
> The whole-server patterns `mcp__locally` and `mcp__locally__*` are also valid
> wherever a tool name is accepted (subagent `tools`, permission rules).

If you haven't installed the server yet, see the [main README](../README.md#usage).

---

## 1. Recommended: a CLAUDE.md instruction

The simplest, lowest-risk lever is a [CLAUDE.md](https://code.claude.com/docs/en/memory)
instruction telling Claude when to delegate. Claude Code loads CLAUDE.md at the
start of every session and follows it as guidance.

Add a block like this to your project's `./CLAUDE.md` (shared with your team via
git) or your personal `~/.claude/CLAUDE.md` (applies to all your projects):

```markdown
## Delegating to locally

The `locally` MCP server runs a smaller local model cheaply. Before doing
low-stakes, mechanical work yourself, delegate it to keep it off the frontier
model — then review the result before relying on it.

- Finding code: call `mcp__locally__explore_task` (read-only) instead of fanning
  out Grep/Read. Pass the relevant directory as the `path` argument so the model
  gets a map to explore from.
- Drafting commit messages, PR descriptions, changelog entries, boilerplate,
  scaffolding, and routine edits: call `mcp__locally__run_task`.

Route by how checkable the answer is, not by topic:

- **Trust it** for names, paths, line numbers, and the set of files matching a
  pattern. This is what it is reliably good at.
- **Expect gaps** on "how does this work" — the answer is usually correct but
  stops short of the full call path.
- **Check it against source** whenever the answer had to be derived: a default
  value, a resolution order, an exhaustive count, or a rule about what runs
  when. These are its characteristic failures.

Keep design decisions, tricky debugging, high-stakes edits, review, audits and
severity calls on the frontier model.
```

This repository already does a minimal version of this — its own `CLAUDE.md` says
*"Try to use locally yourself when working in this repo - but check its work."*

**Things to know:**

- **It's guidance, not enforcement.** The Claude Code docs are explicit:
  *"Claude treats them as context, not enforced configuration."* CLAUDE.md is
  delivered as a message after the system prompt, so there is no strict-compliance
  guarantee. Specific, concrete instructions adhere better than vague ones.
- **Precedence.** CLAUDE.md files are concatenated from broad to specific:
  managed → `~/.claude/CLAUDE.md` (user) → `./CLAUDE.md` or `./.claude/CLAUDE.md`
  (project) → `./CLAUDE.local.md` (local, gitignore it). Instructions closer to your
  working directory are read last, so a project rule refines a personal one.

For most people this is enough. The sections below trade simplicity for stronger
guarantees.

---

## 2. Opt-in: a delegation subagent

If you want a reliable, repeatable way to push work to `locally`, define a
[subagent](https://code.claude.com/docs/en/sub-agents) whose tool access is scoped
to the `locally` tools. A subagent runs in its own context window with exactly the
tools you grant it — so when you invoke this one, the work *can only* go through
`locally`.

Create `.claude/agents/local-delegate.md` in your project (or `~/.claude/agents/`
for all projects):

```markdown
---
name: local-delegate
description: >-
  Delegates low-stakes codebase exploration and routine writing/editing to the
  locally MCP server (a cheap local model). Use for finding code, drafting
  commit messages or boilerplate, and mechanical edits — not for review, design,
  or high-stakes changes.
tools: mcp__locally__explore_task, mcp__locally__run_task, mcp__locally__usage_report
---

You delegate work to the locally MCP server instead of doing it yourself.

- For finding code and factual what/where questions: use `explore_task`
  (read-only), passing the relevant directory as `path`.
- For drafting or routine edits: use `run_task`, passing `path` so the model can
  read and write files.
- Return locally's output along with a one-line note on what you delegated. Flag
  anything that looks wrong — the output comes from a smaller model and should be
  reviewed.
- Before returning an `explore_task` answer, flag any claim it had to derive
  rather than read: a default value, a resolution order, an exhaustive count, or
  a rule about what runs when. Those are its characteristic failures.
```

`tools` is an allowlist: listing only the `mcp__locally__*` tools means this
subagent has no native `Read`/`Edit`/`Bash`, so it must route through `locally`.

**Invoke it** any of these ways:

- Natural language: *"Use the local-delegate subagent to find every file in the auth flow."*
- `@`-mention to guarantee it runs: `@agent-local-delegate draft a commit message`
- Session-wide default: `claude --agent local-delegate` (the whole session runs as
  that subagent — useful for a dedicated "cheap" session).

This is opt-in: Claude only uses the subagent when its `description` matches the
task or when you ask for it. It does not change what the main conversation does on
its own — combine it with the CLAUDE.md instruction above if you want both.

---

## 3. Advanced: permissions and hooks

These give hard, client-enforced control. Use them carefully.

### Auto-approve locally's tools (safe, recommended companion)

So Claude isn't prompted for permission every time it delegates, add the `locally`
tools to `permissions.allow` in
[`.claude/settings.json`](https://code.claude.com/docs/en/settings) (project) or
`~/.claude/settings.json` (user):

```json
{
  "permissions": {
    "allow": [
      "mcp__locally__explore_task",
      "mcp__locally__run_task",
      "mcp__locally__usage_report"
    ]
  }
}
```

(`mcp__locally__*` works too if you want to allow the whole server.) This pairs
well with any of the steering options above.

### Forcing delegation by blocking native tools

To make delegation non-optional you can block Claude's native tools so it has no
choice but to fall back to `locally`. The Claude Code memory docs point here
directly: *"To block an action regardless of what Claude decides, use a PreToolUse
hook instead."*

You can do this with `permissions.deny`:

```json
{
  "permissions": {
    "deny": ["Grep"]
  }
}
```

…or with a [PreToolUse hook](https://code.claude.com/docs/en/hooks) that exits `2`
to block the call and feed a message back to Claude:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Grep",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Use mcp__locally__explore_task for codebase search instead.' >&2; exit 2"
          }
        ]
      }
    ]
  }
}
```

> [!WARNING]
> Broadly denying native tools degrades Claude Code badly — blocking `Read` or
> `Grep` cripples its ability to do almost anything, and round-tripping every read
> through a local model is slow. If you reach for this, scope it narrowly (one tool,
> one project) and expect to tune it. For most users, sections 1 and 2 are the right
> tradeoff; this is here for completeness.

---

## Verifying it's working

`locally` makes its own offloading visible:

- **Per task:** each `explore_task` / `run_task` result ends with a footer like
  `_locally · ornith-1.0-9b-q6_k_xl · 7 iters · 17 files read · 1m54s · ~138k read locally · ~5.8k returned_`.
  If you see it, the work ran locally. `(hit cap)` beside the iteration count means the run
  ran out of its iteration budget rather than finishing.
- **Cumulative:** ask Claude *"how much have we offloaded to locally?"* (or call
  `mcp__locally__usage_report`) for a running total of tasks handled and tokens
  generated locally since the server started.

If you never see the footer, Claude isn't delegating — revisit the CLAUDE.md
wording (make it more specific) or use the subagent in section 2.

---

## Reference

- Claude Code memory / CLAUDE.md — https://code.claude.com/docs/en/memory
- Claude Code subagents — https://code.claude.com/docs/en/sub-agents
- Claude Code settings & permissions — https://code.claude.com/docs/en/settings
- Claude Code hooks — https://code.claude.com/docs/en/hooks
