import { execFile } from "node:child_process";
import type { GitRepoInfo } from "./types.ts";

const GIT_TIMEOUT_MS = 1200;
const GIT_CACHE_TTL_MS = 5000;

export interface GitCacheEntry {
  info: GitRepoInfo | null;
  fetchedAtMs: number;
}

/**
 * Parse `git status --porcelain=v2 --branch` stdout into structured GitRepoInfo.
 * Returns null if the output does not look like a valid porcelain v2 branch status.
 */
export function parseGitPorcelainV2(stdout: string): GitRepoInfo | null {
  let branch: string | null = null;
  let oid: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirtyFiles = 0;
  let sawHeader = false;

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      sawHeader = true;
      const val = line.slice("# branch.oid ".length).trim();
      oid = val && val !== "(initial)" ? val : null;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      sawHeader = true;
      const val = line.slice("# branch.head ".length).trim();
      if (val && val !== "(detached)") {
        branch = val;
      } else {
        branch = null;
      }
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]) || 0;
        behind = Number(match[2]) || 0;
      }
      continue;
    }
    if (line.startsWith("# ")) {
      continue;
    }
    // Porcelain v2 file entry prefixes:
    // 1 = ordinary changed, 2 = renamed/copied, u = unmerged, ? = untracked
    const prefix = line[0];
    if (prefix === "1" || prefix === "2" || prefix === "u" || prefix === "?") {
      dirtyFiles += 1;
    }
  }

  if (!sawHeader) {
    return null;
  }

  const resolvedBranch = branch ?? (oid ? oid.slice(0, 7) : "HEAD");
  return {
    branch: resolvedBranch,
    dirtyFiles,
    ahead,
    behind,
    detached: branch === null,
  };
}

/**
 * Query git repository status for a given directory without acquiring optional locks.
 * Returns null if `cwd` is not inside a git work tree or if git fails/times out.
 */
export function probeGitRepoInfo(cwd: string): Promise<GitRepoInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseGitPorcelainV2(stdout));
      },
    );
  });
}

/**
 * Resolve git info for a set of working directories with deduplication and TTL caching.
 * Returns a Map<cwd, GitRepoInfo | null> containing the latest known info for requested cwds,
 * plus a boolean indicating whether any cached value actually changed.
 */
export async function refreshGitInfoForCwds(
  cwds: Iterable<string>,
  cache: Map<string, GitCacheEntry>,
  options: { force?: boolean; nowMs?: number; ttlMs?: number; probe?: (cwd: string) => Promise<GitRepoInfo | null> } = {},
): Promise<{ changed: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? GIT_CACHE_TTL_MS;
  const probe = options.probe ?? probeGitRepoInfo;

  const uniqueCwds = new Set<string>();
  for (const raw of cwds) {
    const trimmed = raw.trim();
    if (trimmed) uniqueCwds.add(trimmed);
  }

  const toFetch: string[] = [];
  for (const cwd of uniqueCwds) {
    const cached = cache.get(cwd);
    if (options.force || !cached || nowMs - cached.fetchedAtMs >= ttlMs) {
      toFetch.push(cwd);
    }
  }

  if (toFetch.length === 0) {
    return { changed: false };
  }

  let changed = false;
  await Promise.all(
    toFetch.map(async (cwd) => {
      const prev = cache.get(cwd)?.info ?? null;
      const next = await probe(cwd);
      cache.set(cwd, { info: next, fetchedAtMs: nowMs });
      if (!gitInfoEqual(prev, next)) {
        changed = true;
      }
    }),
  );

  return { changed };
}

export function gitInfoEqual(a: GitRepoInfo | null | undefined, b: GitRepoInfo | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.branch === b.branch &&
    a.dirtyFiles === b.dirtyFiles &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    Boolean(a.detached) === Boolean(b.detached)
  );
}
