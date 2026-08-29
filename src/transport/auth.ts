import { createHash, timingSafeEqual } from "node:crypto";
import type { LocallyConfig } from "../config.js";
import { LocallyError } from "../llm/errors.js";

/**
 * The `/mcp` access rules, as pure functions, so the transport stays a router and these stay
 * testable. Two decisions live here: whether a request carries the shared token, and whether the
 * configured bind host is one we are willing to open without a token at all.
 *
 * Deliberately a static shared secret rather than the SDK's OAuth resource-server helpers
 * (`verifyBearerToken` / `requireBearerAuth` / `bearerAuthChallengeResponse` in
 * `@modelcontextprotocol/server`, with `toNodeHandler` forwarding `req.auth` as `ctx.http.authInfo`).
 * Those want an `OAuthTokenVerifier` returning an `AuthInfo`, and reject one whose `expiresAt` is
 * unset; the deployment they describe — an authorization server, scopes, expiring tokens — is not
 * this one, which is a single operator holding a single secret. Reach for them if locally ever
 * fronts a real AS; until then the vocabulary would be in the config file without being true.
 */

/**
 * The token `/mcp` requires, or `undefined` for "no auth". An empty or whitespace-only value reads
 * as unset rather than as a token nobody can guess — a blank string in a config file or an
 * unexported env var means the operator did not configure one, and treating it as a live secret
 * would lock everyone out while looking configured.
 */
export function resolveAuthToken(config: LocallyConfig): string | undefined {
  const token = (config.transport?.authToken ?? process.env.LOCALLY_AUTH_TOKEN)?.trim();
  return token ? token : undefined;
}

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

/**
 * Whether binding this host keeps the server on the local machine. The whole `127.0.0.0/8` block
 * counts, not just `127.0.0.1`.
 *
 * The wildcards `0.0.0.0` and `::` are emphatically *not* loopback: they bind every interface, which
 * makes them the most exposed value, not a neutral default.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_NAMES.has(normalized)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Refuse to open a non-loopback socket with no token on it. Called before `listen`, so a
 * misconfiguration never reaches an open port.
 *
 * There is no override flag on purpose. The failure this guards against is the silent one — a
 * `0.0.0.0` bind that works fine and exposes `run_task`'s write/patch/shell surface to the network
 * without ever saying so — and an env var that turns the guard off is that same silent path wearing
 * a different name.
 */
export function assertBindSafety(host: string, token: string | undefined): void {
  if (token !== undefined || isLoopbackHost(host)) return;

  throw new LocallyError(
    `HTTP transport refuses to bind non-loopback host "${host}" with no auth token: /mcp would accept unauthenticated tool calls — including run_task, which writes files, patches files and runs shell commands — from anything that can reach the port.`,
    {
      category: "config",
      origin: "local",
      retriable: false,
      fix: `Set transport.authToken, or LOCALLY_AUTH_TOKEN in the environment of the server, to require a bearer token on /mcp. You can also bind 127.0.0.1 to keep the server on this machine.`,
    }
  );
}

/**
 * Whether an `Authorization` header presents the configured token.
 *
 * Both sides are hashed before comparison. That is what makes the constant-time compare usable at
 * all here: `timingSafeEqual` throws on a length mismatch, so comparing the raw strings would leak
 * the secret's length through the exception path. Equal-length digests compare in constant time and
 * say nothing about the input.
 */
export function checkBearer(header: string | undefined, token: string): boolean {
  const match = /^bearer[ \t]+(.+)$/i.exec(header?.trim() ?? "");
  if (!match) return false;

  const presented = match[1].trim();
  if (!presented) return false;

  return timingSafeEqual(sha256(presented), sha256(token));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf-8").digest();
}
