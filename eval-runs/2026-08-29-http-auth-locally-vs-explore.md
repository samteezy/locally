<!--
test:
  id: http-transport-access-control
  category: exploration          # exploration | documentation | code-generation
  subject-under-test: locally explore_task (very thorough) — HEAD 3aa90c3, the issue #4 HTTP auth commit
  baseline: native Explore subagent
  identical-prompt: true         # both agents receive the same prompt verbatim
  scoring: inaccuracy-count      # hard vs. minor, verified against source
  pass-criteria: |
    locally's hard-inaccuracy count is <= baseline's, AND its account of the check
    order on POST /mcp and the startup bind guard matches source.
  result: PASS                   # locally 0 hard / 2 minor; Explore 0 hard / 2 minor
  note: |
    Deliberately aimed at code committed hours earlier (src/transport/auth.ts, 88 lines,
    one commit old) so neither agent could be leaning on prior familiarity with the tree.
    The interesting split is depth, not accuracy: Explore followed the request into
    node_modules and documented the SDK entry's own gates; locally stopped at the repo
    boundary and spent its extra breadth on config keys the question did not ask for.
-->

# Eval: HTTP transport access control — locally `explore_task` vs. native Explore agent

The subject is the newest code in the tree: `src/transport/auth.ts` and the `/mcp` router changes
landed by `3aa90c3` ("Put a lock on the HTTP transport, and refuse to bind wide without one"). An
ordered-pipeline question — *what does a request pass through, in what order* — is the shape
`explore_task`'s own tool description warns it is weaker at ("explain how this is wired") while
still being fully checkable against source, which makes it a useful counterweight to the inventory
tasks the previous runs used.

- **Date:** 2026-08-29
- **Branch:** `issue-4-http-auth` @ `3aa90c3`, working tree clean
- **Task type:** Exploration (ordered control-flow trace + config/env enumeration)
- **Prompt (both agents, verbatim):** In this repository, document how the HTTP transport controls access to its endpoints. Cover: (1) every check a request to POST /mcp must pass before a tool call is dispatched, in the order they are applied; (2) how /health differs; (3) every configuration key and environment variable that affects those checks, and what each falls back to when unset; (4) what the server does at startup when the configured bind host is not loopback. Give a file:line citation for every claim.
- **locally run:** `explore_task`, `breadth: "very thorough"`, `path: /root/projects/locally`, agent `ornith-1.0-9b-q6_k_xl`
- **Explore run:** native Explore subagent (frontier model)
- **Cost:** locally = ~198k read locally / ~9.7k returned, 9 iterations, 14 files read, 2m51s. Explore = 47,441 frontier subagent tokens, 24 tool uses, 1m50s.

### Pre-flight

`npm test` clean on the branch (297 tests, 18 files). `npm run build` re-run before the eval. The
MCP server was reconnected at the start of the session; `3aa90c3` touches no file on the
`explore_task` path (`git show --stat`: config, index, server, transport, tests), so the connected
server serves HEAD's explore logic.

Both agents were launched concurrently with the identical prompt string and could not see each
other's work.

---

## Output A — locally (`explore_task`, very thorough)

> Footer reported by the tool:
> `_locally · ornith-1.0-9b-q6_k_xl · 9 iters · 14 files read · 2m51s · ~198k read locally · ~9.7k returned_`

I've now covered all the relevant code. The answer stands — here is the complete, documented picture.

---

## 1. Checks a POST /mcp request passes, in order

All in `src/transport/http.ts`, inside the handler at lines 64–112 (the `startHttp` factory at lines 39–128).

### Step 1 — Path routing (no security check)
Line 72: `req.url === "/mcp"`. Anything else is a 404 (lines 110–111). Pure router, not a security gate.

### Step 2 — DNS-rebinding host header check
Line 51: `hostHeaderValidation(allowedHosts)` from `@modelcontextprotocol/node`, called once at startup and cached. At line 78, `checkHost(req, res)` rejects if the `Host` header is not in the allowlist, writing its own rejection response.

### Step 3 — DNS-rebinding origin header check
Line 52: `originValidation(allowedOrigins)` from `@modelcontextprotocol/node`, called once at startup and cached. At line 78, `checkOrigin(req, res)` rejects if the `Origin` header is not in the allowlist, writes its own rejection response, and — per the comment at lines 76–77 — a present-but-unparseable `Origin` (the `null` sent by sandboxed iframes and `file://` pages) is rejected and cannot be allowlisted.

Both checks are applied in a single `if` at line 78:
```ts
if (!checkHost(req, res) || !checkOrigin(req, res)) return;
```

### Step 4 — Bearer token check (only when `authToken` is configured)
Line 83: `if (authToken !== undefined && !checkBearer(req.headers.authorization, authToken))`. When `authToken` is `undefined`, the branch is skipped entirely — no auth is required. When configured, `checkBearer` (`src/transport/auth.ts:76–84`) parses the `Authorization` header with `/^bearer[ \t]+(.+)$/i` (line 77), extracts and trims the token, then compares SHA-256 digests via `timingSafeEqual` (lines 83–84). A missing, empty, non-bearer, or wrong-length token returns `false`, and the response is HTTP 401 with `WWW-Authenticate: Bearer realm="locally"` and body `{"error":"unauthorized"}` (lines 84–90).

### Step 5 — Body read (capped at 1 MB)
Lines 95–105: `readBody(req)` is awaited. It accumulates chunks, destroying the request and rejecting with "Request body too large" if the total exceeds 1 MB (line 16–20). A JSON parse error yields the raw string.

### Step 6 — MCP handler dispatch
Line 106: `await mcp(req, res, body)` forwards to `@modelcontextprotocol/server`'s handler, which resolves the tool call.

---

## 2. /health — how it differs

`src/transport/http.ts:66–70`:

```ts
if (req.method === "GET" && req.url === "/health") {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", server: "locally" }));
  return;
}
```

- Only `GET` is accepted (POST to `/health` falls through to the 404 at line 110).
- **No** host header check, **no** origin check, **no** bearer token check, **no** body read.
- Returns `{"status":"ok","server":"locally"}` with HTTP 200.
- The comment at lines 81–82 makes the design explicit: `/health` is the liveness check and reports no data, and it stays open so the MCP client can verify the server is up before spending the 1 MB body read on an unauthenticated caller.

---

## 3. Configuration keys and environment variables

### Transport keys — `src/config.ts:32–50` (`TransportConfig` interface)

| Key | Source | Env fallback | Config fallback |
|---|---|---|---|
| `transport.mode` | config file | `LOCALLY_TRANSPORT` | `"stdio"` |
| `transport.port` | config file | `LOCALLY_PORT` | `3000` |
| `transport.host` | config file | `LOCALLY_HOST` | `"127.0.0.1"` |
| `transport.allowedHosts` | config file | none | `[host, "localhost", "127.0.0.1", "[::1]"]` |
| `transport.allowedOrigins` | config file | none | same as `allowedHosts` |
| `transport.authToken` | config file | `LOCALLY_AUTH_TOKEN` | `undefined` (no auth) |

### Resolution order — `src/transport/auth.ts:25–28` (`resolveAuthToken`)

```ts
const token = (config.transport?.authToken ?? process.env.LOCALLY_AUTH_TOKEN)?.trim();
return token ? token : undefined;
```

- `transport.authToken` wins over `LOCALLY_AUTH_TOKEN`.
- Trimming is applied; a blank or whitespace-only value is treated as unset (returns `undefined`).
- Falls back to `undefined` when neither source is set.

### `allowedRoots` — `src/config.ts:70`, `src/tools/sandbox.ts:15–20`

- Config key: `allowedRoots` (array of strings).
- Env fallback: **none**.
- Config fallback: `[process.cwd()]` — the directory the server process was launched in.

### `ignorePatterns` — `src/config.ts:64`

- Config key: `ignorePatterns` (array of strings).
- Env fallback: **none**.
- Config fallback: **none** (empty array if unset).

### Other relevant keys

| Key | Source | Env fallback | Config fallback |
|---|---|---|---|
| `default.baseUrl` | config file | `LOCALLY_BASE_URL` | `"http://localhost:11434/v1"` |
| `default.model` | config file | `LOCALLY_MODEL` | `""` |
| `default.apiKey` | config file | `LOCALLY_API_KEY` | `""` |
| `default.maxTokens` | config file | none | unset |
| `default.timeout` | config file | none | unset |
| `agents.<name>.<field>` | config file | none | inherits from `default` |
| `tools.explore.agent` | config file | none | `undefined` (falls through to tool default) |
| `tools.run.agent` | config file | none | `undefined` (falls through to tool default) |

### `LOCALLY_VERIFY_SYMBOLS` — `src/config.ts:98–101`

- Env var: `LOCALLY_VERIFY_SYMBOLS` (read on every call, not from config).
- Config fallback: **none** — the comment at lines 86–97 explains this is deliberately env-only because `LocallyConfig` is parsed verbatim, and a config key would be unreachable from the environment.
- Fallback value: `true` (enabled). Disabled only by `"0"`, `"false"`, `"off"`, `"no"` (trimmed, lowercased); any other value including `""` leaves it on.

---

## 4. Startup when the configured bind host is not loopback

Enforced **before any socket is opened**, in `src/transport/http.ts:46–47`:

```ts
const authToken = resolveAuthToken(config);
assertBindSafety(host, authToken);
```

### `isLoopbackHost` — `src/transport/auth.ts:39–43`

- Returns `true` for the fixed set `["localhost", "::1", "[::1]", "::ffff:127.0.0.1"]` (line 30, checked at line 41) and any address matching `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` (line 42).
- Returns `false` for `0.0.0.0`, `::`, and any routable address (e.g. `192.168.1.10`, `10.0.0.5`). The comment at lines 36–37 is explicit: the wildcards bind every interface and are "the most exposed value, not a neutral default."

### `assertBindSafety` — `src/transport/auth.ts:54–65`

```ts
export function assertBindSafety(host: string, token: string | undefined): void {
  if (token !== undefined || isLoopbackHost(host)) return;
  throw new LocallyError(
    `HTTP transport refuses to bind non-loopback host "${host}" with no auth token: /mcp would accept unauthenticated tool calls — including run_task, which writes files, patches files and runs shell commands — from anything that can reach the port.`,
    { category: "config", origin: "local", retriable: false, fix: `Set transport.authToken (or LOCALLY_AUTH_TOKEN in the server's environment) to require a bearer token on /mcp, or bind 127.0.0.1 to keep the server on this machine.` }
  );
}
```

- If the host is loopback **or** a token is configured, it returns silently.
- Otherwise it throws a `LocallyError` (category `"config"`, origin `"local"`, retriable `false`). The error includes a `fix` property surfaced on stderr as `Fatal: <message>\nFix: <remedy>` (see `src/index.ts:32–39`).
- The failure is **fatal** — `main()` in `src/index.ts:31–41` calls `process.exit(1)` on any error.
- There is **no override flag** — the comment at lines 49–52 of `auth.ts` says "There is no override flag on purpose" because an env var that turns the guard off would be the same silent failure wearing a different name.

### Startup log line

`src/transport/http.ts:125–127` writes to stderr:
```
locally: /mcp auth: { bearer token required | none (loopback bind only) }
```
So the operator sees which mode was chosen.

---

**Citations**

- `src/transport/http.ts:39-128` — startHttp — full handler with check order
- `src/transport/http.ts:66-70` — /health — no auth, no host/origin, no body
- `src/transport/http.ts:46-48` — pre-bind auth + bind safety
- `src/transport/http.ts:49-52` — allowedHosts/allowedOrigins defaults
- `src/transport/http.ts:78` — host + origin checks combined
- `src/transport/http.ts:83-90` — bearer auth
- `src/transport/http.ts:95-106` — body read + MCP dispatch
- `src/transport/http.ts:125-127` — startup auth log
- `src/transport/auth.ts:25-28` — resolveAuthToken — config beats env, trim-as-unset
- `src/transport/auth.ts:39-43` — isLoopbackHost — loopback set + regex
- `src/transport/auth.ts:54-65` — assertBindSafety — fatal on non-loopback + no token
- `src/transport/auth.ts:76-84` — checkBearer — regex parse, SHA-256, timingSafeEqual
- `src/config.ts:32-50` — TransportConfig interface
- `src/config.ts:56-71` — LocallyConfig — allowedRoots, ignorePatterns
- `src/config.ts:98-101` — symbolCheckEnabled — env-only, truthy default
- `src/config.ts:103-122` — loadConfig — env fallbacks for baseUrl/model/apiKey
- `src/config.ts:185-198` — resolveTransportMode — arg > env > config > stdio
- `src/config.ts:124-135` — resolveConfigPath — env > cwd > home
- `src/tools/sandbox.ts:15-20` — effectiveRoots — allowedRoots or cwd
- `src/index.ts:1-41` — main — startup flow, error surfacing
- `src/index.ts:32-39` — fatal error handling with fix

_Citations: 25 citations checked, all resolve to a real file and line._

---

## Output B — native Explore subagent

## HTTP transport access control — locally

All paths absolute; the transport lives in `/root/projects/locally/src/transport/http.ts` with the access rules factored into `/root/projects/locally/src/transport/auth.ts`.

### 1. Checks a `POST /mcp` request passes, in order

The request handler is a single `node:http` listener (`/root/projects/locally/src/transport/http.ts:64-113`). In order:

1. **Route match — `/health` first.** `GET /health` is matched and answered before anything else, so it never reaches the `/mcp` branch (`http.ts:66-70`).
2. **Exact path match `/mcp`.** The router compares `req.url === "/mcp"` (`http.ts:72`) — a literal string equality, so any query string or trailing slash falls through to the 404 at `http.ts:110-111`. Note the method is *not* checked here; every HTTP method on `/mcp` goes through the checks below.
3. **`Host` header validation (DNS-rebinding guard).** `checkHost` is `hostHeaderValidation(allowedHosts)` (`http.ts:51`), invoked at `http.ts:78`. Implementation: `/root/projects/locally/node_modules/@modelcontextprotocol/node/dist/index.mjs:26-40` — on failure it writes `403` with a JSON-RPC error body (code `-32000`) and returns `false`, and the router returns immediately (`http.ts:78`). The underlying predicate (`/root/projects/locally/node_modules/@modelcontextprotocol/server/dist/index.mjs:1492-1520`) rejects a **missing** `Host` header (`missing_host`, line 1493-1497), an unparseable one (line 1499-1508), and any hostname not in the allowlist (line 1509-1515). Matching is on the parsed hostname only, so it is port-agnostic.
4. **`Origin` header validation.** `checkOrigin` is `originValidation(allowedOrigins)` (`http.ts:52`), invoked in the same expression at `http.ts:78` (short-circuits after Host). Implementation: `node/dist/index.mjs:74-88`, also `403` + JSON-RPC error. Per its documented contract (`node/dist/index.mjs:56-59`), a **missing** `Origin` passes (non-browser clients send none), while a present-but-unallowed or present-but-unparseable value is rejected — the `http.ts:76-77` comment records that the `null` origin sent by sandboxed iframes and `file://` pages is therefore rejected and cannot be allowlisted.
5. **Bearer token check** — only when a token is configured. `authToken !== undefined && !checkBearer(req.headers.authorization, authToken)` → `401` with `WWW-Authenticate: Bearer realm="locally"` and body `{"error":"unauthorized"}` (`http.ts:83-90`). This deliberately runs *before* the body is read (`http.ts:80-82`). `checkBearer` (`/root/projects/locally/src/transport/auth.ts:76-84`) requires a header matching `/^bearer[ \t]+(.+)$/i` after trimming (case-insensitive scheme, space or tab separator), rejects an empty credential, and compares SHA-256 digests with `timingSafeEqual` so a length mismatch cannot throw and leak the secret's length (`auth.ts:68-74`, `auth.ts:86-88`). Rejected forms are pinned in `/root/projects/locally/src/transport/auth.test.ts:66-86`.
6. **Body size cap.** The body is read under a 1 MB cap (`MAX_BODY_BYTES` at `http.ts:8`, enforced in `readBody` at `http.ts:14-22`, which destroys the socket on overflow); the router answers `413 Payload too large` (`http.ts:98-105`). Empty bodies resolve to `undefined` and non-JSON bodies are passed through as the raw string (`http.ts:25-33`).
7. **MCP entry handling** — `await mcp(req, res, body)` (`http.ts:106`), where `mcp` is `toNodeHandler(createMcpHandler(() => createMcpServer(config), ...))` (`http.ts:59-62`). The entry applies, before any tool dispatch: `415` if a POST's `Content-Type` is not `application/json` (`server/dist/index.mjs:1327-1331`); `400 -32700` for an unreadable or non-JSON body (`server/dist/index.mjs:1325-1335`, via `classifyEntryRequest` at `server/dist/index.mjs:1048-1088`); era classification from the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers versus the body (`server/dist/index.mjs:1077-1083`), with disagreements rejected (`server/dist/index.mjs:1340-1342`; documented as `400` in `/root/projects/locally/README.md:426-429`). Legacy (2025-era) traffic falls to the stateless leg, which answers **any non-POST with `405 Method not allowed.`** (`server/dist/index.mjs:967-968`) — the `http.ts:92-94` comment states this is intentionally the entry's job, not the router's — and requires `Accept` to include both `application/json` and `text/event-stream` (`406`, `server/dist/index.mjs:630-634`).
8. **Tool dispatch.** Only then does `tools/call` reach the switch in `/root/projects/locally/src/server.ts:146-208`, which routes `explore_task` / `run_task` / `usage_report` and returns `Unknown tool: <name>` with `isError: true` for anything else (`server.ts:202-206`). There is no per-tool authorization; the remaining containment is the filesystem fence applied inside the tools (`allowedRoots`, noted at `server.ts:100-101` and `server.ts:117-118`, resolved at `/root/projects/locally/src/index.ts:14-16`).

### 2. How `/health` differs

- Matched first and answered inline: requires method `GET` and exact URL `/health`, returns `200` with `{"status":"ok","server":"locally"}` (`http.ts:66-70`). A non-GET `/health` falls through to the 404 (`http.ts:110-111`).
- It skips **all** of the checks above: no `Host` validation, no `Origin` validation, no bearer token, no body-size handling — the `return` at `http.ts:70` precedes the `/mcp` branch entirely. The rationale is recorded at `http.ts:81-82` ("`/health` stays open — it is the liveness check and reports no data") and in `/root/projects/locally/README.md:355-356`.

### 3. Configuration keys and environment variables

| Setting | Config key | Env fallback | Fallback when unset |
|---|---|---|---|
| Transport mode (whether HTTP runs at all) | `transport.mode` (`/root/projects/locally/src/config.ts:33`) | `LOCALLY_TRANSPORT`, and the `--transport` argv flag which wins over both | `"stdio"` — precedence argv → env → config → default, at `/root/projects/locally/src/config.ts:185-198` |
| Port | `transport.port` (`config.ts:34`) | `LOCALLY_PORT` | `3000`, parsed base 10 (`http.ts:40`) |
| Bind host | `transport.host` (`config.ts:35`) | `LOCALLY_HOST` | `"127.0.0.1"` (`http.ts:41`) |
| Allowed `Host` hostnames | `transport.allowedHosts` (`config.ts:36-41`) | none | `[host, "localhost", "127.0.0.1", "[::1]"]` — the resolved bind host plus localhost names (`http.ts:49`) |
| Allowed `Origin` hostnames | `transport.allowedOrigins` (`config.ts:42-43`) | none | the resolved `allowedHosts` array (`http.ts:50`) |
| Bearer token | `transport.authToken` (`config.ts:44-49`) | `LOCALLY_AUTH_TOKEN` | `undefined` = no auth on `/mcp`; config wins over env, both are `.trim()`ed, and an empty/whitespace-only value reads as unset rather than as an unguessable secret (`/root/projects/locally/src/transport/auth.ts:25-28`; asserted in `auth.test.ts:9-28`) |

Two more environment variables gate whether those config values exist at all: `LOCALLY_CONFIG` selects the config file path, otherwise `./locally.config.json` then `~/.locally/config.json`, and if none exists the returned config has **no** `transport` block at all, so every key above falls back (`/root/projects/locally/src/config.ts:103-135`). A config file that fails to parse produces a stderr warning and the same transport-less default (`config.ts:110-121`). Config is read once at startup (`/root/projects/locally/src/index.ts:8`).

Notably, there is **no** env var for `allowedHosts`/`allowedOrigins` — they are config-file only.

### 4. Startup behaviour on a non-loopback bind

Before any socket is opened, `startHttp` resolves the token and calls `assertBindSafety(host, authToken)` (`http.ts:46-47`, with the reasoning at `http.ts:43-45`).

- `assertBindSafety` returns silently if a token is configured **or** the host is loopback; otherwise it throws a `LocallyError` (`/root/projects/locally/src/transport/auth.ts:54-66`) with `category: "config"`, `origin: "local"`, `retriable: false`, and a `fix` naming both remedies (set `transport.authToken` / `LOCALLY_AUTH_TOKEN`, or bind `127.0.0.1`) — `auth.ts:57-65`.
- Loopback means the local names `localhost`, `::1`, `[::1]`, `::ffff:127.0.0.1` (`auth.ts:30`) or the whole `127.0.0.0/8` block by regex (`auth.ts:39-43`). The wildcards `0.0.0.0` and `::` are explicitly **not** loopback (`auth.ts:36-38`).
- There is no override flag, by design (`auth.ts:50-53`).
- The throw propagates out of `startHttp` (called at `/root/projects/locally/src/index.ts:25`) to the top-level catch, which writes `Fatal: <message>` plus `Fix: <fix>` to stderr and exits with code 1 (`/root/projects/locally/src/index.ts:31-41`). Because the throw precedes `httpServer.listen` (`http.ts:115-118`), no port is ever opened.
- On a successful start, stderr states the bound URL and which of the two auth states is in effect: `bearer token required` or `none (loopback bind only)` (`http.ts:120-127`, rationale at `http.ts:123-124`).

Behaviour is pinned by tests at `/root/projects/locally/src/transport/auth.test.ts:31-63`. User-facing documentation of the same rules is `/root/projects/locally/README.md:334-360` and the env-var defaults table at `/root/projects/locally/README.md:265-267`.

---

## Evaluation

### Quantitative — claims verified against source

`L` = locally, `E` = Explore. ✅ correct · ⚠️ imprecise · ✗ missed (not claimed) · ❌ wrong.

| # | Claim | L | E | Ground truth |
|---|---|---|---|---|
| 1 | Check order: route → Host → Origin → Bearer → body cap → entry → dispatch | ✅ | ✅ | `src/transport/http.ts:66,72,78,83,95,106` |
| 2 | `/health` matched before the `/mcp` branch, returns inline | ✅ | ✅ | `http.ts:66-70` |
| 3 | `/mcp` match is exact string equality; anything else 404 | ✅ | ✅ | `http.ts:72`, 404 at `:110-111` |
| 4 | HTTP method is not checked on the `/mcp` branch | ✗ | ✅ | `http.ts:72` has no method test |
| 5 | `checkHost` / `checkOrigin` built once, outside the handler | ✅ | ✅ | `http.ts:51-52`, inside `startHttp` |
| 6 | Both guards evaluated in one short-circuiting `if` | ✅ | ✅ | `http.ts:78` |
| 7 | Guards write their own `403` (JSON-RPC `-32000`) | ✗ | ✅ | `@modelcontextprotocol/node/dist/index.mjs:30-38`, `:78-86` |
| 8 | A **missing** `Host` is rejected | ✗ | ✅ | `server/dist/index.mjs:1493-1497` (`missing_host`) |
| 9 | A **missing** `Origin` passes | ✗ | ✅ | `node/dist/index.mjs:56-59` (documented contract) |
| 10 | Unparseable `null` `Origin` rejected, not allowlistable | ✅ | ✅ | `http.ts:76-77` comment; `server/dist/index.mjs:1499-1508` |
| 11 | Bearer check gated on `authToken !== undefined` | ✅ | ✅ | `http.ts:83` |
| 12 | 401 + `WWW-Authenticate: Bearer realm="locally"` + `{"error":"unauthorized"}` | ✅ | ✅ | `http.ts:84-89` |
| 13 | Auth runs **before** the body read | ✅ | ✅ | `http.ts:83` precedes `:97` |
| 14 | `checkBearer` regex `/^bearer[ \t]+(.+)$/i`, trims, rejects empty | ✅ | ✅ | `auth.ts:77-81` |
| 15 | SHA-256 digests under `timingSafeEqual` (length-leak reason) | ✅ | ✅ | `auth.ts:83`, `:86-88` |
| 16 | 1 MB body cap, socket destroyed on overflow | ✅ | ✅ | `MAX_BODY_BYTES` `http.ts:8`; `:15-19` |
| 17 | Router answers `413 Payload too large` | ✗ | ✅ | `http.ts:100-102` |
| 18 | Empty body → `undefined`; non-JSON → raw string | ✗ | ✅ | `http.ts:25`, `:31` |
| 19 | SDK entry gates before dispatch: 415 / 400 / 406 / 405 | ✗ | ✅ | `server/dist/index.mjs:1330`, `:1333-1336`, `:631-633`, `:968` |
| 20 | Header/body agreement (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) | ✗ | ✅ | `server/dist/index.mjs:1077-1083`, rejected at `:1341-1343` |
| 21 | Tool switch, `Unknown tool: <name>` fallthrough | ✗ | ⚠️ | switch at `server.ts:176`; `Unknown tool` at `:201` (E cited `:202-206`) |
| 22 | `/health` skips every check; non-GET `/health` → 404 | ✅ | ✅ | `http.ts:59-63`, `:110-111` |
| 23 | Reason `/health` is open = liveness check, reports nothing | ⚠️ | ✅ | `http.ts:81-82`; L welds it to the 1 MB-read reasoning (minor #1) |
| 24 | `transport.mode` → `LOCALLY_TRANSPORT` → `"stdio"`, argv `--transport` wins | ✅ | ✅ | `config.ts:186-197` |
| 25 | `transport.port` → `LOCALLY_PORT` → `3000` | ✅ | ✅ | `http.ts:40` |
| 26 | `transport.host` → `LOCALLY_HOST` → `"127.0.0.1"` | ✅ | ✅ | `http.ts:41` |
| 27 | `allowedHosts` default `[host, "localhost", "127.0.0.1", "[::1]"]`, no env var | ✅ | ✅ | `http.ts:49` |
| 28 | `allowedOrigins` defaults to `allowedHosts`, no env var | ✅ | ✅ | `http.ts:50` |
| 29 | `authToken`: config beats env, `.trim()`, blank reads as unset | ✅ | ✅ | `auth.ts:26-27` |
| 30 | `LOCALLY_CONFIG` → cwd → `~/.locally/config.json`; none → no `transport` block | ⚠️ | ✅ | `config.ts:124-135`, `:115-121`; L cites it but omits it from the tables |
| 31 | `assertBindSafety` called before `listen` | ✅ | ✅ | `http.ts:47` vs `:116` |
| 32 | Returns silently if token set **or** host loopback | ✅ | ✅ | `auth.ts:55` |
| 33 | Loopback = 4 names + whole `127.0.0.0/8`; `0.0.0.0` / `::` are not | ✅ | ✅ | `auth.ts:30`, `:41-42` |
| 34 | Throws `LocallyError` config/local/non-retriable with a `fix` | ✅ | ✅ | `auth.ts:57-65` |
| 35 | No override flag, by design | ✅ | ✅ | `auth.ts:49-52` |
| 36 | Top-level catch prints `Fatal:` + `Fix:`, exits 1 | ✅ | ✅ | `index.ts:31-41` |
| 37 | Startup stderr names the auth state | ✅ | ✅ | `http.ts:125-127` |
| 38 | `readBody` overflow branch line range | ⚠️ | ✅ | overflow at `:15-19`; L cited `16-20` (`:20` is the non-overflow push) |
| 39 | `auth.test.ts:66-86` = "rejected forms" | — | ⚠️ | `:66-71` is the **accept** test; rejects are `:72-86` |
| 40 | `allowedRoots` default `[process.cwd()]` | ✅ | ✅ | `config.ts:70`, `sandbox.ts:20` |
| 41 | `ignorePatterns` unset → `[]` at the use site | ✅ | ✗ | `agentic-task.ts:61` (`?? []`) |
| 42 | `LOCALLY_VERIFY_SYMBOLS` env-only, default on, off for `0/false/off/no` | ✅ | ✗ | `config.ts:98-101` |

**Totals — locally: 0 hard, 2 minor (#23, #38). Explore: 0 hard, 2 minor (#21, #39).**

Rows 4, 7–9, 17–20 are omissions, not errors — locally said nothing false about them, it simply
stopped at the repo boundary. Scored as a depth gap, not an inaccuracy, per the convention set in
the previous run.

### Qualitative

- **Citations.** Both were dense and both held up. locally's `<citations>` block was parsed and
  rendered tag-free, and its own footer reported "25 citations checked, all resolve to a real file
  and line" — which independent re-checking confirmed. Explore's citations were, if anything,
  tighter: its four `node_modules` line ranges (`1492-1520`, `1493-1497`, `1499-1508`, `1509-1515`)
  were exact to the line against a 1500-line bundled `.mjs` it had never seen before.
- **Depth is the whole story here.** The prompt said "every check … before a tool call is
  dispatched." Explore read that as a question about the *pipeline* and followed `mcp(req, res, body)`
  into `@modelcontextprotocol/server`, surfacing four more gates (415, 400, 406, 405) and the
  header/body agreement rule. locally treated `await mcp(...)` as the terminus — "forwards to
  `@modelcontextprotocol/server`'s handler, which resolves the tool call" — and stopped. That is the
  documented weakness ("weaker at open-ended 'explain how this is wired' questions") showing up
  exactly where the tool description says it will.
- **Breadth spent in the wrong place.** locally's §3 is the more exhaustive config inventory —
  `allowedRoots`, `ignorePatterns`, `LOCALLY_VERIFY_SYMBOLS`, the per-agent and tool-routing keys —
  but the question asked for the keys that affect *those checks*. Explore enumerated exactly the six
  transport keys plus `LOCALLY_CONFIG` and stopped, then explicitly noted the negative result
  ("there is **no** env var for `allowedHosts`/`allowedOrigins`"). Inventory instinct is locally's
  strength and it fired here without being asked; it cost nothing in accuracy but diluted the answer.
- **The one fabricated sentence.** locally's §2 renders the `http.ts:80-82` comment as `/health`
  staying open "so the MCP client can verify the server is up before spending the 1 MB body read on
  an unauthenticated caller." The source makes two independent statements — auth precedes the body
  read so an unauthenticated caller cannot spend it, *and* `/health` is open because it reports
  nothing — and locally fused them into a causal claim the code does not make. Every mechanical fact
  around it is right; the invented connective tissue is the failure mode to watch, and it is the kind
  of thing no server-side checker can catch, since both halves cite a real line that really says
  those words.
- **Cost.** ~9.7k tokens returned by a 9B local model versus 47.4k frontier subagent tokens for a
  materially deeper answer. The order-of-magnitude saving holds; on this task the frontier agent
  bought real extra coverage with it rather than just polish.

### Takeaway

**PASS.** locally 0 hard / 2 minor, Explore 0 hard / 2 minor — equal on accuracy, which is the pass
criterion, and locally's account of the check order and the bind guard matches source exactly. This
is the third consecutive run with zero hard errors from locally.

The result to carry forward is that on *one-commit-old code* — `auth.ts` did not exist yesterday —
locally got every mechanical fact right. Accuracy is no longer the axis on which these two differ.
Depth is: asked to trace a pipeline, locally documents the part inside the repo and treats the
library call as a leaf, while the frontier agent treats it as an edge to follow. That is a fair
description of the tool's advertised contract rather than a defect, and it sharpens when to reach
for which — locally for "what is here and where," the frontier agent for "and then what happens."

### Method recap (repeatable)

1. Picked a subject committed hours earlier, so neither agent could coast on familiarity.
2. Same prompt string to both, launched concurrently, neither able to see the other.
3. Pre-flight: `npm test` (297 passing) and `npm run build`; confirmed via `git show --stat` that the
   commit under study does not touch the `explore_task` code path, so the reconnected MCP server
   serves HEAD.
4. Re-read every cited file at HEAD (`git show HEAD:<path> | cat -n`) rather than trusting a working
   read — one `cat -n` in this session returned a stale copy of `http.ts`, which would have
   invalidated every line number in the table had it gone unnoticed.
5. Verified all 42 rows against source, including Explore's `node_modules` citations.
6. Scored hard vs. minor per agent; omissions recorded as depth gaps, not inaccuracies.
