#!/usr/bin/env node
// runner <spec-issue> [--concurrency 2] [--no-ci]
// runner clean     (removes worktrees kept for needs-human tickets)
//
// Builds a spec's tickets unattended into the integration branch spec/<N>:
// each unblocked ticket gets a worktree and a headless `claude -p "/implement #N"`;
// the runner opens its PR, waits for CI, squash-merges it and closes the ticket,
// which unblocks the next ones.
//
// Stateless: every decision is re-read from GitHub (assignees, PRs, labels,
// native blocking) and the child logs, so a rerun after a crash picks up where
// it stopped. One Node TypeScript file, no build, no deps.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const POLL_MS = 60_000; // only PRs waiting on CI are polled
const NO_CHECKS_GRACE = 3; // polls to wait for CI to register checks on a fresh PR

/** A file's text, or "" when it doesn't exist (yet). */
const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// ── Preflight ──────────────────────────────────────────────────────────────

export type RepoFacts = {
  tracker: string | null; // docs/agents/issue-tracker.md, written by /setup
  scratch: boolean; // .scratch/ exists: a local-markdown tracker's issue dir
  ci: boolean; // .github/workflows/ has a workflow
};

/** Why the runner won't work this repo, or null when it will. */
export function refusal(repo: RepoFacts, opts: { ci: boolean }): string | null {
  const kind = repo.tracker?.match(/^# Issue tracker: (.+)$/m)?.[1].trim();
  if (kind !== "GitHub" && (kind || repo.scratch)) {
    return `runner supports GitHub Issues only (docs/agents/issue-tracker.md says: ${kind ?? "missing, .scratch/ present"})`;
  }
  if (!repo.ci && opts.ci) {
    return "no CI workflow in .github/workflows/, so ticket PRs can't be checked before merge; add one, or pass --no-ci to merge once /implement's own tests pass";
  }
  return null;
}

function repoFacts(repo: string): RepoFacts {
  const workflows = join(repo, ".github/workflows");
  return {
    tracker: readText(join(repo, "docs/agents/issue-tracker.md")) || null,
    scratch: existsSync(join(repo, ".scratch")),
    ci: existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f)),
  };
}

// ── GitHub snapshot ────────────────────────────────────────────────────────

export type Ticket = {
  number: number;
  title: string;
  url: string;
  open: boolean;
  assignees: string[];
  labels: string[];
  blockedBy: number; // open native blockers only
};

/** Parses `gh api .../sub_issues --paginate --slurp` (an array of pages). */
export function children(json: string): Ticket[] {
  const pages: any[][] = JSON.parse(json);
  return pages.flat().map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    open: issue.state === "open",
    assignees: issue.assignees.map((a: any) => a.login),
    labels: issue.labels.map((l: any) => l.name),
    blockedBy: issue.issue_dependencies_summary?.blocked_by ?? 0,
  }));
}

/** Tickets ready to take: open, unblocked, unclaimed, not waiting on a human. */
export function frontier(tickets: Ticket[]): Ticket[] {
  return tickets.filter(
    (t) => t.open && t.blockedBy === 0 && t.assignees.length === 0 && !t.labels.includes("needs-human"),
  );
}

// ── Children (claude -p) ───────────────────────────────────────────────────

/** The child's session id, read back from its stream-json log. */
export function sessionOf(log: string): string | null {
  const ids = [...log.matchAll(/"session_id":"([^"]+)"/g)];
  return ids.at(-1)?.[1] ?? null;
}

/** The child's last invocation, from its `init` event on: a resumed log keeps the earlier ones. */
function lastInvocation(log: string): string {
  return log.slice(Math.max(0, log.lastIndexOf('"subtype":"init"')));
}

/**
 * The child's final result event, if its last turn ended. Claude streams a few
 * system events after the result, so it's the last result of the last invocation.
 */
function result(log: string): any | null {
  const line = lastInvocation(log).split("\n").findLast((l) => l.includes('"type":"result"'));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/**
 * Why a child that exited didn't finish its turn, or null when it did.
 * A usage limit is a failure too: callers wait it out (see usageLimit) instead of giving up.
 */
export function failure(code: number, log: string): string | null {
  const end = result(log);
  if (code !== 0) return `claude exited ${code}`;
  if (!end) return "claude ended without a result";
  if (end.is_error) return `claude ended with ${end.subtype}`;
  return null;
}

/** The child's last turn ended cleanly, e.g. before the runner crashed. */
function finished(log: string): boolean {
  return failure(0, log) === null;
}

// ── Usage limits ───────────────────────────────────────────────────────────

/**
 * When a child that stopped on a usage limit can go on (epoch ms), or null when it hit none.
 * Reads only the last invocation (from its `init` event on): a resumed log keeps the old limit.
 * Prefers the structured `rate_limit_event`; falls back to the limit message's text.
 */
export function usageLimit(log: string, now: number, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const turn = lastInvocation(log);
  const events = turn.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const rejected = events.findLast((e) => e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected");
  const resetsAt = rejected?.rate_limit_info.resetsAt;
  // "You've hit your session limit · resets 3:45pm", "Your limit will reset at 1pm (Etc/GMT+5)."
  const message = turn.match(/hit your (?:[\w-]+ )?limit · resets ([^"\\\n]+)|limit will reset at ([^"\\\n]+?)\.?(?:"|\\n|$)/m);
  if (!message && !rejected) return null;
  const reset = typeof resetsAt === "number" ? resetsAt * 1000 : message ? resetTime((message[1] ?? message[2]).trim(), now, zone) : null;
  return reset === null ? now + LIMIT_FALLBACK_MS : Math.max(reset, now + 60_000); // a past reset can't spin
}

/** How long to wait when a limit's reset time can't be read. */
export const LIMIT_FALLBACK_MS = 30 * 60_000;

/** Next "3:45pm", "11am" or "Mon 12:00am" after `now`, with an optional " (Area/City)" zone. */
function resetTime(text: string, now: number, zone: string): number | null {
  const m = text.match(/^(?:(sun|mon|tue|wed|thu|fri|sat)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i);
  if (!m) return null;
  const [, day, h, min = "0", half, tz = zone] = m;
  const hour = (Number(h) % (half ? 12 : 24)) + (half?.toLowerCase() === "pm" ? 12 : 0);
  try {
    const wall = (t: number) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(t);
      const get = (type: string) => parts.find((p) => p.type === type)!.value;
      return { y: +get("year"), mo: +get("month") - 1, d: +get("day"), h: +get("hour"), mi: +get("minute"), wd: get("weekday").toLowerCase() };
    };
    // Wall clock in `tz` → instant: guess as UTC, correct by the zone's offset there (twice, for DST edges).
    const at = (y: number, mo: number, d: number) => {
      let t = Date.UTC(y, mo, d, hour, Number(min));
      for (let i = 0; i < 2; i++) {
        const w = wall(t);
        t += Date.UTC(y, mo, d, hour, Number(min)) - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
      }
      return t;
    };
    const today = wall(now);
    for (let ahead = 0; ahead <= 7; ahead++) {
      const t = at(today.y, today.mo, today.d + ahead);
      if (t > now && (!day || wall(t).wd === day.toLowerCase().slice(0, 3))) return t;
    }
  } catch {
    return null; // unknown zone
  }
  return null;
}

const DESIGN_OFF = { "design@skills": false, "impeccable@impeccable": false };

/** What a child is asked, and whether its work is UI (the design plugin stays on). */
export type Prompt = { text: string; ui: boolean };

const isUi = (t: Ticket) => t.labels.includes("ui");

/** A ticket's first prompt; `context` (a retry's answers) follows it. */
const implement = (t: Ticket, context = ""): Prompt => ({ text: `/implement #${t.number}${context && `\n\n${context}`}`, ui: isUi(t) });

/** Arguments for a fresh child, or for resuming one whose session already exists. */
export function claudeArgs(prompt: Prompt, session: { id: string; resume: boolean }): string[] {
  const start = ["-p", prompt.text, session.resume ? "--resume" : "--session-id", session.id];
  // Non-ui work runs without the design plugin, so its Stop "design deep pass"
  // hook and agents don't burn tokens on backend work. Both install ids: this
  // marketplace's and impeccable's own, if that is installed too.
  const design = prompt.ui ? [] : ["--settings", JSON.stringify({ enabledPlugins: DESIGN_OFF })];
  // Headless -p denies anything needing approval unless a mode is set.
  // Hook events in the log show whether the design Stop hook ran.
  const stream = ["--output-format", "stream-json", "--verbose", "--include-hook-events"];
  return [...start, ...design, ...stream, "--permission-mode", "auto", "--permission-prompts", "none"];
}

// ── Checks and PRs ─────────────────────────────────────────────────────────

export type Checks = "pass" | "fail" | "pending" | "none";

/** Reads `gh pr checks <pr> --json name,bucket`. Exit 1 alone is ambiguous, so go by the output. */
export function checks(out: { code: number; stdout: string; stderr: string }): Checks {
  if (/no checks reported/.test(out.stderr)) return "none";
  let buckets: string[];
  try {
    buckets = JSON.parse(out.stdout).map((c: any) => c.bucket);
  } catch {
    return "pending"; // API hiccup: ask again next poll
  }
  if (buckets.length === 0) return "none";
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "fail";
  if (buckets.includes("pending")) return "pending";
  return "pass";
}

/** Body of the spec/<N> → main PR. Merging it closes the spec and its tickets. */
export function specPrBody(spec: { number: number; url: string }, tickets: Ticket[], unresolved: string[] = []): string {
  const list = tickets.map((t) => `- [${t.open ? " " : "x"}] #${t.number} ${t.title}`);
  const closes = [spec.number, ...tickets.map((t) => t.number)].map((n) => `#${n}`).join(", ");
  const findings = unresolved.length ? ["Unresolved review findings:", ...unresolved.map((f) => `- ${f}`), ""] : [];
  return [`Spec: ${spec.url}`, "", "Tickets:", ...list, "", ...findings, `Closes ${closes}`, ""].join("\n");
}

// The final review: one child, two turns. The second turn fixes what the first found.
export const FIX_PROMPT =
  "Fix the findings from your review on this branch: commit each fix and run the tests; don't push. " +
  "End your reply with a line `Unresolved findings:` followed by one `- ` bullet per finding you couldn't fix, or `None`.";

/** Findings the review child couldn't fix, from its final reply. */
export function unresolvedFindings(reply: string): string[] {
  const at = reply.lastIndexOf("Unresolved findings:");
  if (at < 0) return [];
  return reply
    .slice(at)
    .split("\n")
    .slice(1)
    .flatMap((l) => l.match(/^\s*[-*] (.+)$/)?.[1].trim() ?? []);
}

export type Merged = { ticket: Ticket; pr: number };
export type Stuck = { ticket: Ticket; why: string; log: string };

/** What merged, what's stuck and what's still open, with links. */
export function summary(merged: Merged[], stuck: Stuck[], tickets: Ticket[]): string {
  const line = (t: Ticket, note: string) => `  #${t.number} ${t.title}: ${note} (${t.url})`;
  const done = new Set([...merged, ...stuck].map((m) => m.ticket.number));
  const open = tickets.filter((t) => t.open && !done.has(t.number));
  const why = (t: Ticket) =>
    t.labels.includes("needs-human") ? "needs-human" : t.blockedBy ? "blocked" : t.assignees.length ? `assigned to ${t.assignees.join(", ")}` : "open";
  return [
    `Merged (${merged.length}):`, ...merged.map((m) => line(m.ticket, `PR #${m.pr}`)),
    `Stuck (${stuck.length}):`, ...stuck.map((s) => line(s.ticket, `${s.why}, log ${s.log}`)),
    `Still open (${open.length}):`, ...open.map((t) => line(t, why(t))),
  ].join("\n");
}

/** A child that ends its turn without a commit has stopped to ask something. */
export const NO_COMMIT = "claude finished without committing";
/** Marks the runner's `needs-human` comments, so a retry knows which comments came after. */
export const NEEDS_HUMAN_MARK = "<!-- runner:needs-human -->";

/** The `needs-human` comment: Claude's question, or why the runner stopped plus a log summary. */
export function needsHuman(why: string, log: string, at: { log: string; worktree: string }): string {
  const end = result(log);
  const reply = String(end?.result ?? "").trim();
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const head = why === NO_COMMIT && reply ? "Claude stopped with a question:" : `The runner stopped on this ticket: ${why}.`;
  const last = reply && why !== NO_COMMIT ? ["", "Claude's last message:", "", quote(reply)] : reply ? ["", quote(reply)] : [];
  const denied = end?.permission_denials?.length ? `, ${end.permission_denials.length} permission denials` : "";
  const stats = end ? ` (${end.subtype}, ${end.num_turns ?? "?"} turns${denied})` : " (no result: the child was cut off)";
  return [
    NEEDS_HUMAN_MARK,
    head,
    ...last,
    "",
    `Log: \`${at.log}\`${stats}`,
    `Worktree kept for inspection: \`${at.worktree}\``,
    "",
    "Answer or fix here, then remove the `needs-human` label: the runner retries with your comment as extra context.",
  ].join("\n");
}

/**
 * Human comments since the runner first stopped on the ticket, without its own
 * `needs-human` comments (`gh issue view --json comments`): a second stop keeps the first answer.
 */
export function answers(json: string): string {
  const bodies: string[] = JSON.parse(json).comments.map((c: any) => c.body);
  const first = bodies.findIndex((b) => b.includes(NEEDS_HUMAN_MARK));
  return bodies.slice(first + 1).filter((b) => !b.includes(NEEDS_HUMAN_MARK)).join("\n\n---\n\n").trim();
}

/** The number in a PR's URL, as `gh pr create` prints it. */
const prNumber = (url: string) => Number(url.match(/\/pull\/(\d+)/)![1]);

// ── Exec seam: every gh, git and claude call goes through here ─────────────

export type ExecResult = { code: number; stdout: string; stderr: string };
/** `log` appends the command's stdout to that file instead of returning it. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; log?: string }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((done, fail) => {
    const log = opts.log ? openSync(opts.log, "a") : null;
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", log ?? "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (log !== null) closeSync(log);
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });

// ── Updating a ticket branch from spec/<N> ─────────────────────────────────

export type Update = { status: "current" | "merged" } | { status: "conflict"; files: string[] } | { status: "failed"; why: string };

/** Merges the fetched spec/<N> tip into the branch checked out at `dir`. A conflict stays in place to resolve. */
export async function updateFromSpec(exec: Exec, dir: string, specBranch: string): Promise<Update> {
  const tip = `origin/${specBranch}`;
  if ((await exec("git", ["merge-base", "--is-ancestor", tip, "HEAD"], { cwd: dir })).code === 0) return { status: "current" };
  const out = await exec("git", ["merge", "--no-edit", tip], { cwd: dir });
  if (out.code === 0) return { status: "merged" };
  const files = await conflicted(exec, dir);
  return files.length ? { status: "conflict", files } : { status: "failed", why: `git merge ${tip} failed: ${out.stderr.trim()}` };
}

/** Why the merge in `dir` isn't done yet, or null once it's committed with no conflicts left. */
export async function unmerged(exec: Exec, dir: string): Promise<string | null> {
  const files = await conflicted(exec, dir);
  if (files.length) return `still conflicted: ${files.join(", ")}`;
  const merging = (await exec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir })).code === 0;
  return merging ? "merge not committed" : null;
}

async function conflicted(exec: Exec, dir: string): Promise<string[]> {
  const out = await exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
  return out.stdout.split("\n").filter(Boolean);
}

export type Deps = { exec: Exec; sleep: (ms: number) => Promise<unknown>; say: (msg: string) => void; now?: () => number };
export type Options = { spec: number; repo: string; ci: boolean; concurrency: number };

// ── The loop ───────────────────────────────────────────────────────────────

/** Works the spec until nothing is takeable. Exit code: 0 all done, 1 tickets left, 2 refused. */
export async function run(opts: Options, deps: Deps): Promise<number> {
  const { spec, repo, ci, concurrency } = opts;
  const { exec, say } = deps;
  const now = deps.now ?? Date.now;
  const specBranch = `spec/${spec}`;

  const why = refusal(repoFacts(repo), { ci });
  if (why) {
    say(`runner: ${why}`);
    return 2;
  }

  /** Runs a command that may fail; the caller reads the result. */
  const attempt = (cmd: string, args: string[], cwd = repo) => exec(cmd, args, { cwd });
  /** Runs a command that must succeed; returns its trimmed stdout. */
  const output = async (cmd: string, args: string[], cwd = repo) => {
    const out = await attempt(cmd, args, cwd);
    if (out.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${out.code}): ${out.stderr.trim()}`);
    return out.stdout.trim();
  };
  const worktree = (t: Ticket) => join(repo, ".worktrees", String(t.number));
  const logOf = (t: Ticket) => join(repo, ".worktrees/logs", `${t.number}.jsonl`);
  const readLog = (t: Ticket) => readText(logOf(t));
  const branch = (t: Ticket) => `ticket/${t.number}`;

  // Setup: who claims, keep .worktrees/ out of the target repo's status, spec/<N> from the default branch.
  const me = await output("gh", ["api", "user", "--jq", ".login"]);
  const specIssue = JSON.parse(await output("gh", ["issue", "view", String(spec), "--json", "title,url"]));
  const defaultBranch = await output("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  await ignoreWorktrees();
  await output("git", ["fetch", "origin"]);
  if ((await attempt("git", ["ls-remote", "--exit-code", "--heads", "origin", specBranch])).code !== 0) {
    await output("git", ["push", "origin", `origin/${defaultBranch}:refs/heads/${specBranch}`]);
    await output("git", ["fetch", "origin"]);
    say(`Created ${specBranch} from ${defaultBranch}`);
  }

  type Done = { ticket: Ticket; code: number };
  const running = new Map<number, Promise<Done>>();
  const waiting = new Map<number, { ticket: Ticket; pr: number; misses: number }>(); // PRs waiting on CI
  const merged: Merged[] = [];
  const stuck: Stuck[] = [];
  let tickets: Ticket[] = [];
  let labelReady: Promise<string> | undefined; // `needs-human` created once per run

  while (true) {
    tickets = children(await output("gh", ["api", `repos/{owner}/{repo}/issues/${spec}/sub_issues`, "--paginate", "--slurp"]));
    const prs = await openTicketPrs();
    const tracked = (t: Ticket) => running.has(t.number) || waiting.has(t.number) || stuck.some((s) => s.ticket.number === t.number);

    // Ours from an earlier run first (a PR waits on CI, otherwise its child (re)starts), then the frontier.
    const mine = tickets.filter((t) => t.open && t.assignees.includes(me) && !tracked(t));
    for (const t of mine.filter((t) => prs.has(t.number))) waiting.set(t.number, { ticket: t, pr: prs.get(t.number)!, misses: 0 });
    // A child that stopped on a usage limit is still ours and unfinished, so it's in `mine` and resumes here.
    const queue = [...mine.filter((t) => !prs.has(t.number)), ...frontier(tickets)];
    while (running.size < concurrency && queue.length) {
      const t = queue.shift()!;
      if (!t.assignees.includes(me)) await output("gh", ["issue", "edit", String(t.number), "--add-assignee", "@me"]);
      running.set(t.number, startChild(t));
    }

    if (running.size === 0 && waiting.size === 0) break;
    if (await pollWaiting()) continue; // a merge may have unblocked tickets
    if (running.size === 0 && waiting.size === 0) continue; // the last waiting PR got stuck: nothing left to wait on

    // React as soon as a child exits; wake for the next CI poll if a PR is waiting.
    const poll = waiting.size ? deps.sleep(POLL_MS).then(() => null) : new Promise<null>(() => {});
    const next = await Promise.race([...running.values(), poll]);
    if (next) {
      running.delete(next.ticket.number);
      await publish(next);
    }
  }

  const pr = tickets.some((t) => !t.open) ? await ensureSpecPr() : null;
  const done = tickets.every((t) => !t.open);
  const reviewed = done && pr ? await reviewSpec(pr) : true;
  say(summary(merged, stuck, tickets));
  return done && reviewed ? 0 : 1;

  // ── Steps ──

  async function ignoreWorktrees() {
    const exclude = resolve(repo, await output("git", ["rev-parse", "--git-path", "info/exclude"]));
    const text = readText(exclude);
    if (/^\/?\.worktrees\/?$/m.test(text)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.worktrees/\n`);
  }

  async function openTicketPrs(): Promise<Map<number, number>> {
    const out = await output("gh", ["pr", "list", "--base", specBranch, "--state", "open", "--json", "number,headRefName", "--limit", "200"]);
    const prs = JSON.parse(out) as { number: number; headRefName: string }[];
    return new Map(
      prs.flatMap((p) => {
        const n = p.headRefName.match(/^ticket\/(\d+)$/)?.[1];
        return n ? [[Number(n), p.number] as [number, number]] : [];
      }),
    );
  }

  /** Worktree + branch off spec/<N>, then `claude -p`; resumes the session if its log has one. */
  async function startChild(t: Ticket): Promise<Done> {
    const dir = worktree(t);
    const context = !t.assignees.includes(me) && (existsSync(dir) || existsSync(logOf(t))) ? await retry(t) : "";
    if (!existsSync(dir)) {
      const exists = (await attempt("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch(t)}`])).code === 0;
      await output("git", exists ? ["worktree", "add", dir, branch(t)] : ["worktree", "add", "-b", branch(t), dir, `origin/${specBranch}`]);
    }
    mkdirSync(dirname(logOf(t)), { recursive: true });
    const log = readLog(t);
    if (finished(log)) return { ticket: t, code: 0 }; // finished before a crash
    const id = sessionOf(log);
    say(`#${t.number}: ${id ? "resuming" : "starting"} claude in ${dir}`);
    const args = id ? claudeArgs({ text: "continue", ui: isUi(t) }, { id, resume: true }) : claudeArgs(implement(t, context), { id: randomUUID(), resume: false });
    const out = await exec("claude", args, { cwd: dir, log: logOf(t) });
    return { ticket: t, code: out.code };
  }

  /**
   * A ticket we gave up on earlier is takeable again: someone removed `needs-human`.
   * Drops the old worktree, keeps the old log aside, returns the answers for the fresh child.
   */
  async function retry(t: Ticket): Promise<string> {
    await attempt("git", ["worktree", "remove", "--force", worktree(t)]);
    if (existsSync(logOf(t))) renameSync(logOf(t), logOf(t).replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
    // The local branch is the stopped run's: start from what was pushed (its PR's), else the spec/<N> tip.
    const pushed = (await attempt("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch(t)}`])).code === 0;
    await output("git", ["branch", "-f", branch(t), pushed ? `origin/${branch(t)}` : `origin/${specBranch}`]);
    const answer = answers(await output("gh", ["issue", "view", String(t.number), "--json", "comments"]));
    say(`#${t.number}: retrying after needs-human`);
    return answer && `This is a retry: the runner stopped on this ticket earlier. Answers on the ticket since then:\n\n${answer}`;
  }

  /** A child exited: push its branch and open the ticket PR into spec/<N>. */
  async function publish({ ticket: t, code }: Done) {
    const why = failure(code, readLog(t));
    if (why && (await waitOutLimit(`#${t.number}`, readLog(t)))) return; // still ours and unfinished: resumes on the next pass
    if (why) return giveUp(t, why);
    const ahead = Number(await output("git", ["rev-list", "--count", `origin/${specBranch}..${branch(t)}`], worktree(t)));
    if (!ahead) return giveUp(t, NO_COMMIT);
    await output("git", ["push", "-u", "origin", branch(t)], worktree(t));
    // A retry after a CI failure or a conflict pushes to the PR it already has.
    let pr = (await openTicketPrs()).get(t.number);
    if (pr === undefined) {
      const body = `Ticket #${t.number} for spec #${spec}, built by the runner. The runner merges it and closes #${t.number}.`;
      pr = prNumber(await output("gh", ["pr", "create", "--base", specBranch, "--head", branch(t), "--title", t.title, "--body", body]));
      say(`#${t.number}: opened PR #${pr}`);
    } else say(`#${t.number}: pushed to PR #${pr}`);
    waiting.set(t.number, { ticket: t, pr, misses: 0 });
  }

  /**
   * If the last claude run in `log` stopped on a usage limit: waits until the reset and returns true.
   * Nothing starts meanwhile. Running children aren't killed: they hit the same limit and exit on
   * their own, and their tickets resume like this one.
   */
  async function waitOutLimit(who: string, log: string): Promise<boolean> {
    const until = usageLimit(log, now());
    if (until === null) return false;
    say(`${who}: usage limit, paused until ${new Date(until).toLocaleString()}`);
    await deps.sleep(Math.max(0, until - now()));
    return true;
  }

  /** Resumes the ticket's own session with `prompt`, again after a usage limit. Why it failed, or null. */
  async function resumeChild(t: Ticket, prompt: string): Promise<string | null> {
    const id = sessionOf(readLog(t));
    if (!id) return "there's no session to resume";
    const args = claudeArgs({ text: prompt, ui: isUi(t) }, { id, resume: true });
    let why: string | null;
    do {
      const out = await exec("claude", args, { cwd: worktree(t), log: logOf(t) });
      why = failure(out.code, readLog(t));
    } while (why && (await waitOutLimit(`#${t.number}`, readLog(t))));
    return why;
  }

  /**
   * Brings each waiting PR up to the spec/<N> tip first (GitHub runs no CI on a conflicting
   * PR), then merges it once its checks pass (all of them under --no-ci). True if any merged.
   */
  async function pollWaiting(): Promise<boolean> {
    let any = false;
    for (const entry of [...waiting.values()]) {
      const { ticket: t, pr } = entry;
      const update = await updateTicket(t);
      if (update === "stuck") {
        waiting.delete(t.number);
        continue;
      }
      // The updated branch needs green CI again before it merges.
      if (update === "updated" && ci) {
        entry.misses = 0;
        continue;
      }
      const state = ci ? checks(await attempt("gh", ["pr", "checks", String(pr), "--json", "name,bucket"])) : "pass";
      if (state === "pending" || (state === "none" && ++entry.misses < NO_CHECKS_GRACE)) continue;
      waiting.delete(t.number);
      if (state !== "pass") {
        await giveUp(t, state === "fail" ? `CI failed on PR #${pr}` : `no CI checks on PR #${pr}`);
        continue;
      }
      any = (await merge(t, pr)) || any;
    }
    return any;
  }

  /**
   * Brings the ticket branch up to the spec/<N> tip and pushes it. A conflict goes back to the
   * child's own session, once; under --no-ci so does a clean merge, to rerun the tests.
   */
  async function updateTicket(t: Ticket): Promise<"current" | "updated" | "stuck"> {
    const dir = worktree(t);
    await output("git", ["fetch", "origin"]);
    if (!existsSync(dir)) await output("git", ["worktree", "add", "-B", branch(t), dir, `origin/${branch(t)}`]);
    const update = await updateFromSpec(exec, dir, specBranch);
    let why: string | null;
    switch (update.status) {
      case "current":
        return "current";
      case "failed":
        why = update.why;
        break;
      case "conflict":
        why = await resolveConflict(t, update.files); // its prompt reruns the tests too
        break;
      case "merged":
        why = ci ? null : await retest(t); // CI reruns on the push
        break;
    }
    if (why) {
      await giveUp(t, why);
      return "stuck";
    }
    await output("git", ["push", "origin", branch(t)], dir);
    say(`#${t.number}: updated ${branch(t)} from ${specBranch}`);
    return "updated";
  }

  /** Resumes the ticket's session to resolve the conflicted merge and rerun tests. Why it didn't, or null. */
  async function resolveConflict(t: Ticket, files: string[]): Promise<string | null> {
    const conflict = `merging ${specBranch} into ${branch(t)} conflicted in ${files.join(", ")}`;
    say(`#${t.number}: ${conflict}; resuming claude to resolve it`);
    const prompt = `Merging origin/${specBranch} into this branch conflicted in: ${files.join(", ")}. ` +
      "Resolve the conflicts so both sides' changes still work, rerun the tests until they pass, and commit the merge.";
    const why = (await resumeChild(t, prompt)) ?? (await unmerged(exec, worktree(t)));
    return why && `${conflict}, still unresolved: ${why}`;
  }

  /** --no-ci: nothing checks the merged spec/<N> changes, so the child reruns its tests once. Why they fail, or null. */
  async function retest(t: Ticket): Promise<string | null> {
    say(`#${t.number}: merged ${specBranch} into ${branch(t)}; resuming claude to rerun the tests`);
    const prompt = `This branch was just updated from origin/${specBranch}, and there's no CI to check it. ` +
      "Rerun the project's tests until they pass, commit any fixes, and don't push.";
    const why = await resumeChild(t, prompt);
    return why && `tests after merging ${specBranch} into ${branch(t)} still failing: ${why}`;
  }

  async function merge(t: Ticket, pr: number): Promise<boolean> {
    const out = await attempt("gh", ["pr", "merge", String(pr), "--squash"]);
    if (out.code !== 0) {
      await giveUp(t, `merge of PR #${pr} failed: ${out.stderr.trim()}`);
      return false;
    }
    // Closing keywords only fire on the default branch, so close the ticket here.
    await output("gh", ["issue", "close", String(t.number), "--comment", `Merged in #${pr} into ${specBranch}.`]);
    await attempt("git", ["worktree", "remove", "--force", worktree(t)]);
    await attempt("git", ["branch", "-D", branch(t)]);
    await attempt("git", ["push", "origin", "--delete", branch(t)]);
    t.open = false;
    for (const s of tickets) if (s.number === t.number) s.open = false; // `t` may be from an earlier snapshot
    merged.push({ ticket: t, pr });
    say(`#${t.number}: merged PR #${pr} into ${specBranch}`);
    await ensureSpecPr();
    return true;
  }

  type SpecPr = { number: number; state: string; isDraft: boolean };

  /** Draft spec/<N> → default branch, opened after the first merge. Any state counts, so a merged one isn't reopened. */
  async function ensureSpecPr(): Promise<SpecPr> {
    const out = await output("gh", ["pr", "list", "--head", specBranch, "--base", defaultBranch, "--state", "all", "--json", "number,state,isDraft"]);
    const found: SpecPr[] = JSON.parse(out);
    if (found.length) return found[0];
    const body = specPrBody({ number: spec, url: specIssue.url }, tickets);
    const title = `Spec #${spec}: ${specIssue.title.replace(/^Spec:\s*/i, "")}`; // /to-spec titles start "Spec: "
    const url = await output("gh", ["pr", "create", "--draft", "--base", defaultBranch, "--head", specBranch, "--title", title, "--body", body]);
    say(`Opened draft PR ${specBranch} → ${defaultBranch}`);
    return { number: prNumber(url), state: "OPEN", isDraft: true };
  }

  /**
   * All tickets closed: one `/code-review` child on spec/<N> fixes what it can, the rest goes in
   * the PR body; once CI passes on the fixes, the PR is marked ready. Ready (or merged) means
   * reviewed, so a rerun skips it; an interrupted review resumes from its log. False if the
   * review child failed or CI did.
   */
  async function reviewSpec(pr: SpecPr): Promise<boolean> {
    if (pr.state !== "OPEN" || !pr.isDraft) return true;
    const dir = join(repo, ".worktrees", `spec-${spec}`);
    const logPath = join(repo, ".worktrees/logs", `spec-${spec}-review.jsonl`);
    const log = () => readText(logPath);
    // The worktree is at the spec/<N> tip, so the review covers what's changed since the default branch.
    const turns = [`/code-review origin/${defaultBranch}`, FIX_PROMPT];
    const ui = tickets.some(isUi);
    await output("git", ["fetch", "origin"]);
    if (!existsSync(dir)) await output("git", ["worktree", "add", "--detach", dir, `origin/${specBranch}`]);
    mkdirSync(dirname(logPath), { recursive: true });

    // Turns done = successful results in the log; a failed or killed turn is sent again.
    const results = () =>
      log().trim().split("\n").flatMap((l) => (l.includes('"type":"result"') ? [JSON.parse(l)] : [])).filter((r) => !r.is_error);
    for (let turn = results().length; turn < turns.length; turn = results().length) {
      const id = sessionOf(log());
      say(`${specBranch}: ${turn ? "fixing review findings" : "reviewing"} in ${dir}`);
      const session = id ? { id, resume: true } : { id: randomUUID(), resume: false };
      const out = await exec("claude", claudeArgs({ text: turns[turn], ui }, session), { cwd: dir, log: logPath });
      const why = failure(out.code, log());
      if (why && (await waitOutLimit(specBranch, log()))) continue; // the same turn again, resumed in its session
      if (why) {
        say(`${specBranch}: review stopped: ${why}, log ${logPath}; the PR stays draft, rerun to resume`);
        return false;
      }
    }

    const ahead = Number(await output("git", ["rev-list", "--count", `origin/${specBranch}..HEAD`], dir));
    if (ahead) await output("git", ["push", "origin", `HEAD:refs/heads/${specBranch}`], dir);
    const unresolved = unresolvedFindings(results().at(-1)?.result ?? "");
    await output("gh", ["pr", "edit", String(pr.number), "--body", specPrBody({ number: spec, url: specIssue.url }, tickets, unresolved)]);
    const state = ci ? await settledChecks(pr.number) : "pass";
    if (state !== "pass") {
      const why = state === "fail" ? `CI failed on PR #${pr.number}` : `no CI checks on PR #${pr.number}`;
      say(`${specBranch}: stuck: ${why} after the review fixes; the PR stays draft, rerun once it's green`);
      return false;
    }
    await output("gh", ["pr", "ready", String(pr.number)]);
    await attempt("git", ["worktree", "remove", "--force", dir]);
    say(`${specBranch}: reviewed (${ahead} fix commit(s), ${unresolved.length} unresolved); PR #${pr.number} ready`);
    return true;
  }

  /** Waits for a PR's checks to finish. The first poll waits too, so a fresh push registers its run. */
  async function settledChecks(pr: number): Promise<Checks> {
    for (let misses = 0; ; ) {
      await deps.sleep(POLL_MS);
      const state = checks(await attempt("gh", ["pr", "checks", String(pr), "--json", "name,bucket"]));
      if (state !== "pending" && (state !== "none" || ++misses >= NO_CHECKS_GRACE)) return state;
    }
  }

  /**
   * Hands a ticket to a human: comment (the question, or why + a log summary), `needs-human`, unassign.
   * Its worktree stays for inspection; removing the label makes it takeable again.
   */
  async function giveUp(t: Ticket, why: string) {
    stuck.push({ ticket: t, why, log: logOf(t) });
    say(`#${t.number}: stuck: ${why}`);
    await output("gh", ["issue", "comment", String(t.number), "--body", needsHuman(why, readLog(t), { log: logOf(t), worktree: worktree(t) })]);
    labelReady ??= output("gh", ["label", "create", "needs-human", "--color", "D93F0B", "--description", "Runner stopped: needs a human", "--force"]);
    await labelReady;
    await output("gh", ["issue", "edit", String(t.number), "--add-label", "needs-human", "--remove-assignee", "@me"]);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** `runner clean`: removes the worktrees left in .worktrees/ (tickets kept on needs-human, spec reviews). Logs stay. */
export async function clean(repo: string, deps: Deps): Promise<number> {
  const root = join(repo, ".worktrees");
  const ours = (d: string) => /^(spec-)?\d+$/.test(d);
  const dirs = existsSync(root) ? readdirSync(root).filter(ours).sort((a, b) => a.localeCompare(b, "en", { numeric: true })) : [];
  for (const d of dirs) {
    const out = await deps.exec("git", ["worktree", "remove", "--force", join(root, d)], { cwd: repo });
    deps.say(out.code === 0 ? `Removed .worktrees/${d}` : `Couldn't remove .worktrees/${d}: ${out.stderr.trim()}`);
  }
  await deps.exec("git", ["worktree", "prune"], { cwd: repo });
  return 0;
}

const usage = "usage: runner <spec-issue> [--concurrency 2] [--no-ci]\n       runner clean";

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: { ci: { type: "boolean", default: true }, concurrency: { type: "string", default: "2" } },
  });
  const cleaning = positionals.length === 1 && positionals[0] === "clean";
  const spec = Number(positionals[0]);
  const concurrency = Number(values.concurrency);
  if (!cleaning && (positionals.length !== 1 || !Number.isInteger(spec) || !(concurrency >= 1))) {
    console.error(usage);
    return 2;
  }
  const top = await realExec("git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    console.error("runner: run it inside the target repo's clone");
    return 2;
  }
  const deps: Deps = { exec: realExec, sleep, say: (msg) => console.error(msg) };
  if (cleaning) return clean(top.stdout.trim(), deps);
  return run({ spec, repo: top.stdout.trim(), ci: values.ci!, concurrency }, deps);
}

// import.meta.main needs Node 24.2; compare paths so Node 23.6+ works too (bin/runner is a symlink).
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
