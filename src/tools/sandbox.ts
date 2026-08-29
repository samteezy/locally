import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LocallyConfig } from "../config.js";
import { LocallyError } from "../llm/errors.js";

/**
 * Filesystem containment for the model-driven tools. The local model can ask read_file /
 * write_file / patch_file / explore_files / run_shell to touch any path; these helpers confine
 * every such path to a set of allowed roots so a prompt-injected model can't read or overwrite
 * arbitrary files on the host.
 */

/**
 * The roots the file & shell tools are actually confined to for a given config: the configured
 * `allowedRoots` if set and non-empty, otherwise the launch directory. Resolved to canonical
 * absolute paths. This is the single source of truth shared by the startup log (so the active
 * fence is visible) and per-task enforcement (so they can't drift).
 */
export function effectiveRoots(config: LocallyConfig): string[] {
  return resolveRoots(config.allowedRoots?.length ? config.allowedRoots : [process.cwd()]);
}

/**
 * Resolve configured roots to absolute, symlink-canonical paths. Unreadable or non-existent
 * roots are skipped; if none resolve we throw (a misconfigured `allowedRoots` fails closed
 * rather than silently confining nothing).
 */
export function resolveRoots(roots: string[]): string[] {
  const resolved: string[] = [];
  for (const r of roots) {
    try {
      resolved.push(realpathSync(resolve(r)));
    } catch {
      // Skip a root that doesn't exist or isn't readable.
    }
  }
  if (resolved.length === 0) {
    throw new LocallyError(
      `None of the configured allowedRoots exist or are readable: ${roots.join(", ") || "(empty)"}`,
      {
        category: "config",
        origin: "local",
        retriable: false,
        fix: "set allowedRoots in locally.config.json to directories that exist. Remove the field to use the launch directory. Then reconnect the server.",
      }
    );
  }
  return resolved;
}

/**
 * Assert that `target` resolves inside one of `roots`; return the canonical absolute path.
 *
 * `realpath` follows symlinks before the check, so a symlink that points outside the roots is
 * rejected even if the link itself sits inside a root. `realpath` also throws on a path that
 * doesn't exist yet, so for writes (`mustExist` false) we canonicalize the parent directory and
 * re-attach the basename — otherwise creating a new file would always fail containment.
 */
export function assertWithinRoots(
  target: string,
  roots: string[],
  opts: { mustExist?: boolean } = {}
): string {
  const abs = resolve(target);

  let canonical = abs;
  try {
    // If the target exists (including as a symlink) this resolves it fully.
    canonical = realpathSync(abs);
  } catch {
    if (!opts.mustExist) {
      // New file: canonicalize the parent (resolving any symlinked ancestors) then re-attach
      // the basename. If the parent doesn't exist either, fall back to the lexical path —
      // resolve() has already collapsed any "..", so traversal is still caught.
      try {
        canonical = join(realpathSync(dirname(abs)), basename(abs));
      } catch {
        canonical = abs;
      }
    }
    // mustExist && missing: keep the lexical path; the tool itself will surface its own ENOENT.
  }

  const contained = roots.some((root) => {
    const rel = relative(root, canonical);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });

  if (!contained) {
    throw new LocallyError(
      `Path is outside the allowed roots. "${target}" resolves to "${canonical}", which is not within: ${roots.join(", ")}`,
      {
        category: "constraint",
        origin: "local",
        retriable: false,
        fix: "use a path inside one of the allowed roots. You can also add the directory to allowedRoots in locally.config.json and then reconnect the server.",
      }
    );
  }

  return canonical;
}
