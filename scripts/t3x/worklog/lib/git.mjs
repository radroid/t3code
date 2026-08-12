// Git and `gh` evidence for the /worklog collector — see docs/t3x/worklog-design.md §3.
//
// T3code persists nothing about commits or pull requests, so the only source of truth is the
// working machine. Every shell call goes through an injected runner: that keeps the test suite
// offline, and it keeps this module honest about the fact that all of it is best-effort. Nothing
// here throws — a missing repo, an absent `gh`, or a dead network degrades to a warning, because a
// work log that refuses to render because GitHub was unreachable is worse than one with a gap.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// git log records are delimited with ASCII RS/US rather than a printable sentinel so a commit
// subject can never forge a delimiter. `--numstat` interleaves diff rows with the pretty format,
// and RS is what lets one parse recover both halves from a single spawn.
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// `--since`/`--until` filter on COMMITTER date, but the log reports AUTHOR date (%aI) because that
// is when the work happened. On this fork main is force-rebased, so the two routinely differ by
// days. The git-level bounds therefore exist only to prune traversal; the exact window test runs in
// JS against %aI.
//
// The two pads are deliberately different sizes. A rebase moves the committer date FORWARD, so an
// in-window commit can surface far past `end` (hence the generous upper pad) but essentially never
// before `start` (hence the small lower one, which only absorbs clock skew and timezone slop).
// Bounding the upper end at all is a trade: a commit rebased more than a month after the day it was
// authored is missed, which is far cheaper than letting a report for an old day walk all of history.
const SINCE_SKEW_PAD_MS = 2 * DAY_MS;
const UNTIL_REBASE_PAD_MS = 30 * DAY_MS;

// `--all` means every ref under refs/, and on a T3code-managed repo that is a trap: T3 writes a
// checkpoint commit per turn under refs/t3/, and this fork carries 337 of them. Including that
// namespace made a single day's `--numstat` output 49.7 MB against 102 KB without it — past the
// 16 MB buffer, so the whole call failed and the day silently reported zero commits. Notes and the
// stash are excluded for the same reason: machine-generated, never the user's work.
const EXCLUDED_REF_GLOBS = ["refs/t3/*", "refs/notes/*", "refs/stash"];

const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.*)$/u;

// A GitHub login is 1–39 characters of alphanumerics with single interior hyphens — never a space,
// a dot or an "@". That is precisely what makes a login separable from the git names and emails
// sharing the `identities` list, so one list can answer both "are these my commits" and "is this
// my pull request".
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/iu;

/** Build a spawnSync-backed shell runner that reports failure as data instead of throwing. */
export function createRunner({ timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  return function run(cmd, args = [], options = {}) {
    try {
      const result = NodeChildProcess.spawnSync(cmd, args, {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeoutMs ?? timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        // Never a shell: every argument here can contain a path, a branch name, or a GitHub search
        // string, and none of them are ours to trust with word splitting.
        shell: false,
        env: env ?? process.env,
        windowsHide: true,
      });
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      // A spawn-level failure (ENOENT, ETIMEDOUT, ENOBUFS) leaves the child's stderr empty, so the
      // error message is the only description of what went wrong. Reporting "" there is how a
      // blown maxBuffer turns into a silent zero-commit day.
      const childStderr = typeof result.stderr === "string" ? result.stderr : "";
      const stderr =
        childStderr !== ""
          ? childStderr
          : result.error
            ? String(result.error.message ?? result.error)
            : "";
      // A missing binary, a bad cwd, and a timeout all arrive as `error` with a null status. They
      // are indistinguishable to a caller that only wants "did this work", so they collapse here.
      const ok = result.error == null && result.status === 0;
      return { ok, code: result.status, stdout, stderr };
    } catch (error) {
      return { ok: false, code: null, stdout: "", stderr: String(error?.message ?? error) };
    }
  };
}

/** Resolve a directory to its repo root plus a key that every worktree of that repo shares. */
export function canonicalRepo(dir, run = createRunner()) {
  if (typeof dir !== "string" || dir.trim() === "") return null;
  try {
    const toplevel = run("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    if (!toplevel.ok) return null;
    const root = toplevel.stdout.trim();
    if (root === "") return null;

    // `--git-common-dir` is emitted relative to the CWD, not the toplevel, so it is deliberately
    // asked for from `root` — that makes "resolve against the toplevel" true rather than merely
    // true-when-you-happen-to-be-at-the-top. Linked worktrees point at the primary repo's .git, so
    // the realpath of that directory collapses all worktrees of one repo onto a single key.
    const common = run("git", ["rev-parse", "--git-common-dir"], { cwd: root });
    const rawCommon = common.ok ? common.stdout.trim() : "";
    const commonDir =
      rawCommon === "" ? NodePath.join(root, ".git") : NodePath.resolve(root, rawCommon);

    let key = commonDir;
    try {
      key = NodeFS.realpathSync(commonDir);
    } catch {
      // A .git that cannot be realpath'd is still a usable identity; the raw path is the fallback.
    }
    return { root, commonDir, key };
  } catch {
    return null;
  }
}

/** Derive `owner/name` for a repo from its origin remote URL, or null if there is no GitHub one. */
export function remoteNameWithOwner(root, run = createRunner()) {
  // Deliberately NOT `gh repo view`: radroid/t3code is a fork of pingdotgg/t3code, and gh resolves
  // a fork to its PARENT. Asking gh would silently report the upstream's pull requests as this
  // user's work. The origin URL is the only answer that stays on the fork.
  try {
    const remote = run("git", ["remote", "get-url", "origin"], { cwd: root });
    if (!remote.ok) return null;
    return parseNameWithOwner(remote.stdout.trim());
  } catch {
    return null;
  }
}

/** List this repo's commits authored inside [start, end), one git call, numstat churn included. */
export function commitsInWindow(root, window = {}, run = createRunner()) {
  return readCommits(root, window, run).commits;
}

/** Fetch merged pull requests for `owner/name` inside [start, end); never fails, only warns. */
export function mergedPrs(nameWithOwner, window = {}, run = createRunner()) {
  const warnings = [];
  if (typeof nameWithOwner !== "string" || nameWithOwner.trim() === "") {
    warnings.push("No GitHub remote resolved; skipped the merged pull request lookup.");
    return { prs: [], warnings };
  }
  const repo = nameWithOwner.trim();

  const startMs = toEpochMs(window.start, Number.NEGATIVE_INFINITY);
  const endMs = toEpochMs(window.end, Number.POSITIVE_INFINITY);
  // Commits are filtered by identity, so pull requests must be too or the two headline numbers are
  // computed to different standards: every PR anyone merged in a repo the user touched — a
  // colleague's, Dependabot's — would otherwise land in "N PRs merged" as the user's own work.
  const logins = loginsFrom(window.identities);

  try {
    const args = [
      "pr",
      "list",
      // `--repo` is load-bearing for the same fork reason as remoteNameWithOwner.
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      "100",
      "--json",
      "number,title,url,mergedAt,additions,deletions,author,headRefName",
    ];
    const search = searchQualifier(startMs, endMs);
    if (search !== "") args.push("--search", search);

    const result = run("gh", args, {});
    if (!result.ok) {
      warnings.push(
        `gh pr list failed for ${repo}: ${firstLine(result.stderr) || "gh unavailable"}`,
      );
      return { prs: [], warnings };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      warnings.push(`gh pr list returned unparseable JSON for ${repo}; skipped merged PRs.`);
      return { prs: [], warnings };
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`gh pr list returned an unexpected shape for ${repo}; skipped merged PRs.`);
      return { prs: [], warnings };
    }

    const prs = [];
    for (const row of parsed) {
      if (row == null || typeof row !== "object") continue;
      const mergedAt = typeof row.mergedAt === "string" ? row.mergedAt : null;
      // The `merged:` search qualifier is date-granular and timezone-fuzzy, so it is padded by a
      // day on each side (see searchQualifier) and the real boundary is enforced right here.
      const mergedMs = toEpochMs(mergedAt, Number.NaN);
      if (!Number.isFinite(mergedMs) || mergedMs < startMs || mergedMs >= endMs) continue;
      const author = typeof row.author?.login === "string" ? row.author.login : null;
      // A known login is filtered strictly, an unattributable row included: the safe reading of a
      // configured registry is "only mine", the same rule the commit scan applies.
      if (logins.size > 0 && (author == null || !logins.has(author.toLowerCase()))) continue;
      prs.push({
        number: typeof row.number === "number" ? row.number : null,
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        mergedAt,
        additions: toCount(row.additions),
        deletions: toCount(row.deletions),
        author,
        headRefName: typeof row.headRefName === "string" ? row.headRefName : null,
      });
    }
    prs.sort((left, right) => toEpochMs(left.mergedAt, 0) - toEpochMs(right.mergedAt, 0));
    // Dropping every PR when no login is known would hide real work, and keeping them silently
    // would credit other people's; the honest third option is to keep them and say so. Nothing to
    // caveat when the window held no PRs at all.
    if (logins.size === 0 && prs.length > 0) {
      warnings.push(
        `Merged PRs for ${repo} could not be attributed to you — no GitHub login in \`identities\`, so they may include other people's.`,
      );
    }
    return { prs, warnings };
  } catch (error) {
    warnings.push(`Merged PR lookup for ${repo} failed: ${String(error?.message ?? error)}`);
    return { prs: [], warnings };
  }
}

/** Ask `gh` who is signed in, as the `@login` entry the registry's `identities` list expects. */
export function githubLoginIdentity(run = createRunner()) {
  // `init` calls this once to seed the login; without it every merged PR in a repo the user
  // touched is attributed to them. The "@" is what tells a login apart from a one-word git author
  // name later — a bare `radroid` in `identities` is ambiguous, `@radroid` never is.
  try {
    const result = run("gh", ["api", "user", "-q", ".login"], {});
    if (!result.ok) return null;
    const login = firstLine(result.stdout);
    return LOGIN.test(login) ? `@${login}` : null;
  } catch {
    return null;
  }
}

/** Collect commits and merged PRs for a set of directories, visiting each repo exactly once. */
export function collectGit(dirs, window = {}, { run = createRunner() } = {}) {
  const warnings = [];
  const repos = [];
  const seen = new Set();

  for (const dir of Array.isArray(dirs) ? dirs : dirs == null ? [] : [dirs]) {
    const repo = canonicalRepo(dir, run);
    if (repo == null) {
      warnings.push(`Not a git repository, skipped: ${String(dir)}`);
      continue;
    }
    // Worktrees of one repo share an object store, so they would otherwise contribute the same
    // commits two or three times over — this fork has three checkouts of itself.
    if (seen.has(repo.key)) continue;
    seen.add(repo.key);

    const repoWarnings = [];
    const nameWithOwner = remoteNameWithOwner(repo.root, run);
    if (nameWithOwner == null) {
      repoWarnings.push(`No GitHub origin remote for ${repo.root}.`);
    }

    const commits = readCommits(repo.root, window, run);
    repoWarnings.push(...commits.warnings);

    const prs = mergedPrs(nameWithOwner, window, run);
    repoWarnings.push(...prs.warnings);

    repos.push({
      key: repo.key,
      root: repo.root,
      nameWithOwner,
      commits: commits.commits,
      mergedPrs: prs.prs,
      warnings: repoWarnings,
    });
  }

  return { repos, warnings };
}

// --- internals -------------------------------------------------------------------------------

// Same work as commitsInWindow, but it keeps the warnings that the array-shaped public contract
// has nowhere to put. collectGit wants them; a direct caller does not.
function readCommits(root, window = {}, run = createRunner()) {
  const warnings = [];
  if (typeof root !== "string" || root.trim() === "") {
    return { commits: [], warnings: ["No repository root given; skipped commits."] };
  }

  const startMs = toEpochMs(window.start, Number.NEGATIVE_INFINITY);
  const endMs = toEpochMs(window.end, Number.POSITIVE_INFINITY);
  // "Filter" and "which identities" are two questions. An identities list that is non-empty but
  // yields nothing usable is a broken registry, and the safe reading of a broken registry is zero
  // commits — not everyone's. A day that reports nothing is a visible prompt to fix the config;
  // a day that credits a colleague's commits to the author reads as perfectly plausible.
  const filterByAuthor = Array.isArray(window.identities) && window.identities.length > 0;
  const identities = normalizeIdentities(window.identities);

  try {
    const args = [
      // Non-ASCII paths would otherwise arrive C-quoted ("caf\303\251.txt") and every consumer
      // downstream would have to know that.
      "-c",
      "core.quotePath=false",
      "log",
      // Every --exclude applies to the ref-listing option that FOLLOWS it, so these must precede
      // --all or they are silently ignored.
      ...EXCLUDED_REF_GLOBS.map((glob) => `--exclude=${glob}`),
      "--all",
      "--no-merges",
      "--numstat",
      // %S needs --source; it names the ref the commit was reached from, which is the only
      // per-commit branch attribution available without one `git branch --contains` spawn each.
      "--source",
      `--pretty=format:${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%S${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%s`,
    ];
    if (Number.isFinite(startMs)) {
      args.push(`--since=${new Date(startMs - SINCE_SKEW_PAD_MS).toISOString()}`);
    }
    if (Number.isFinite(endMs)) {
      args.push(`--until=${new Date(endMs + UNTIL_REBASE_PAD_MS).toISOString()}`);
    }

    const result = run("git", args, { cwd: root });
    if (!result.ok) {
      return {
        commits: [],
        warnings: [`git log failed in ${root}: ${firstLine(result.stderr) || "unknown error"}`],
      };
    }

    const byPatch = new Map();
    for (const chunk of result.stdout.split(RECORD_SEPARATOR)) {
      if (chunk.trim() === "") continue;
      const commit = parseCommitRecord(chunk);
      if (commit == null) continue;
      if (!Number.isFinite(commit.atMs) || commit.atMs < startMs || commit.atMs >= endMs) continue;
      if (filterByAuthor && !matchesIdentity(commit, identities)) continue;

      const key = patchIdentity(commit);
      const existing = byPatch.get(key);
      if (existing == null) {
        byPatch.set(key, commit);
      } else if (existing.branches.length === 0 && commit.branches.length > 0) {
        // Both copies are the same patch, so the count is already right either way; this only
        // decides which SHA gets shown. A copy no branch reaches is history kept alive by a
        // recovery tag, and the branch-reachable one is the commit the user can still `git show`.
        mergeBranches(commit, existing.branches);
        byPatch.set(key, commit);
      } else {
        mergeBranches(existing, commit.branches);
      }
    }

    const commits = [...byPatch.values()]
      .map(({ atMs: _atMs, ...commit }) => commit)
      .sort((left, right) =>
        left.at === right.at ? left.sha.localeCompare(right.sha) : left.at < right.at ? -1 : 1,
      );
    return { commits, warnings };
  } catch (error) {
    return {
      commits: [],
      warnings: [`Commit scan failed in ${root}: ${String(error?.message ?? error)}`],
    };
  }
}

function parseCommitRecord(chunk) {
  const lines = chunk.split("\n");
  const fields = lines[0].split(FIELD_SEPARATOR);
  if (fields.length < 8) return null;
  const [sha, shortSha, at, author, authorEmail, sourceRef, decorations] = fields;
  if (!/^[0-9a-f]{7,64}$/u.test(sha)) return null;
  // A subject containing US would otherwise be truncated; %s is last precisely so it can be rejoined.
  const subject = fields.slice(7).join(FIELD_SEPARATOR);

  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const paths = new Set();
  for (const line of lines.slice(1)) {
    const row = NUMSTAT_ROW.exec(line);
    if (row == null) continue;
    const path = resolveRenameTarget(row[3]);
    if (path === "") continue;
    // A path seen twice in one commit is not two files; renames make that shape reachable.
    if (paths.has(path)) continue;
    paths.add(path);
    files += 1;
    // Binary files report "-\t-": real churn that git cannot count in lines, so it lands as zero
    // rather than being dropped — the file still counts toward `files`.
    if (row[1] !== "-") insertions += Number(row[1]);
    if (row[2] !== "-") deletions += Number(row[2]);
  }

  return {
    sha,
    shortSha,
    at,
    atMs: toEpochMs(at, Number.NaN),
    author,
    authorEmail,
    subject,
    files,
    insertions,
    deletions,
    branches: collectBranches(sourceRef, decorations),
  };
}

// git renders a rename inside --numstat as `dir/{old => new}/file` or `old.txt => new.txt`. Only
// the destination matters to a work log; the brace form can also delete a path component, which is
// why the rebuilt path gets its doubled slashes collapsed.
function resolveRenameTarget(raw) {
  const brace = /^(.*?)\{(.*) => (.*)\}(.*)$/u.exec(raw);
  if (brace != null) {
    return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/gu, "/").replace(/^\//u, "");
  }
  const arrow = raw.split(" => ");
  if (arrow.length === 2 && arrow[1] !== "") return arrow[1];
  return raw;
}

function collectBranches(sourceRef, decorations) {
  const branches = [];
  const add = (candidate) => {
    const name = shortenRef(candidate);
    if (name !== "" && !branches.includes(name)) branches.push(name);
  };
  add(sourceRef);
  for (const piece of String(decorations ?? "").split(",")) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    // `%D` renders the checked-out branch as "HEAD -> name"; the arrow is decoration, not a ref.
    add(trimmed.startsWith("HEAD -> ") ? trimmed.slice("HEAD -> ".length) : trimmed);
  }
  return branches;
}

function shortenRef(ref) {
  const value = String(ref ?? "").trim();
  if (value === "" || value === "HEAD" || value === "grafted" || value === "replaced") return "";
  // Tags are not branches, and the stash is not work.
  if (value.startsWith("tag: ") || value.startsWith("refs/tags/")) return "";
  if (value === "refs/stash" || value === "stash") return "";
  if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length);
  if (value.startsWith("refs/remotes/")) return value.slice("refs/remotes/".length);
  return value;
}

function normalizeIdentities(identities) {
  const set = new Set();
  for (const identity of Array.isArray(identities) ? identities : []) {
    const normalized = normalizeIdentity(identity);
    if (normalized !== "") set.add(normalized);
  }
  return set;
}

// A GitHub noreply address exists in two interchangeable forms — with and without the numeric user
// id — and a registry written by hand will carry whichever one the user happened to copy.
function normalizeIdentity(value) {
  const lower = String(value ?? "")
    .trim()
    .toLowerCase();
  const noreply = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/u.exec(lower);
  return noreply == null ? lower : `${noreply[1]}@users.noreply.github.com`;
}

function matchesIdentity(commit, identities) {
  return (
    identities.has(normalizeIdentity(commit.author)) ||
    identities.has(normalizeIdentity(commit.authorEmail))
  );
}

// Two commits are the same piece of work when a rebase or cherry-pick copied one into the other,
// and `--all` reaches both. Deduping by SHA cannot see that: a copy keeps the author, the AUTHOR
// date and the subject, and changes exactly the SHA and the committer date. On this fork that is
// the normal case rather than an edge — every sync replays ~91 patches onto upstream while the
// pre-sync recovery tag keeps the originals reachable, so a sync day counted almost all of its
// commits and their churn twice.
//
// The knowing cost: two genuinely distinct commits by one author, in the same second, with the
// same subject collapse into one. That shape is a scripted loop, not a person, and undercounting
// it is far cheaper than the several-fold overcount it prevents.
//
// NUL joins the three fields because git cannot store one in a name, an address or a subject, so
// no value can spell another tuple's key. A space could: "Version 2" + 100 + "x" joins to the same
// string as "Version" + 2 + "100 x".
function patchIdentity(commit) {
  const who = normalizeIdentity(commit.authorEmail) || normalizeIdentity(commit.author);
  return `${who}\0${commit.atMs}\0${commit.subject}`;
}

function mergeBranches(commit, branches) {
  for (const branch of branches) {
    if (!commit.branches.includes(branch)) commit.branches.push(branch);
  }
}

// The GitHub logins hiding in an `identities` list, in the three forms it can carry them: the
// explicit `@login` that `githubLoginIdentity` writes, a bare login, and a noreply address — whose
// local part IS the login, which is why a registry seeded only from `git config user.email`
// already knows it. A one-word git author name that is not the user's login is the hazard here;
// it costs the PR count, never the commit count, and `@login` is the way out of it.
function loginsFrom(identities) {
  const logins = new Set();
  for (const identity of Array.isArray(identities) ? identities : []) {
    const value = String(identity ?? "")
      .trim()
      .toLowerCase();
    if (value === "") continue;
    const noreply = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/u.exec(value);
    const candidate = noreply != null ? noreply[1] : value.startsWith("@") ? value.slice(1) : value;
    if (LOGIN.test(candidate)) logins.add(candidate);
  }
  return logins;
}

function parseNameWithOwner(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  const trimmed = url.trim();

  let pathPart = "";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu.exec(trimmed);
  if (scheme != null) {
    // file:// is a local clone, not a forge — there is no owner/name to report.
    if (scheme[1].toLowerCase() === "file") return null;
    const rest = scheme[2];
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    pathPart = rest.slice(slash + 1);
  } else {
    // scp-like `[user@]host:owner/name.git`. The colon must precede any slash, which is what keeps
    // a plain filesystem path (no colon at all) from being mistaken for a remote.
    const scp = /^(?:[^@/]+@)?([^@/:]+):(.+)$/u.exec(trimmed);
    if (scp == null) return null;
    pathPart = scp[2];
  }

  const segments = pathPart.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1].replace(/\.git$/iu, "");
  const owner = segments[segments.length - 2];
  if (owner === "" || name === "") return null;
  return `${owner}/${name}`;
}

// GitHub's `merged:` qualifier takes a bare date and interprets it without our timezone, so the
// range is padded by a day on each side and the caller-visible boundary is applied in JS.
function searchQualifier(startMs, endMs) {
  const parts = [];
  if (Number.isFinite(startMs)) parts.push(`merged:>=${localDateStamp(startMs - DAY_MS)}`);
  if (Number.isFinite(endMs)) parts.push(`merged:<=${localDateStamp(endMs + DAY_MS)}`);
  return parts.join(" ");
}

function localDateStamp(epochMs) {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function toEpochMs(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

function toCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
