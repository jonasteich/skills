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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const POLL_MS = 60_000; // only PRs waiting on CI are polled
const NO_CHECKS_GRACE = 3; // polls to wait for CI to register checks on a fresh PR

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
  const read = (path: string) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null);
  const workflows = join(repo, ".github/workflows");
  return {
    tracker: read("docs/agents/issue-tracker.md"),
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

/** The child's final result event, if its last turn ended. */
function result(log: string): any | null {
  const last = log.trim().split("\n").at(-1);
  try {
    const event = JSON.parse(last ?? "");
    return event.type === "result" ? event : null;
  } catch {
    return null;
  }
}

/** Why a child that exited didn't finish its ticket, or null when it did. */
// A usage limit is a failure too; callers check usageLimit() first: pause and resume, not needs-human.
export function failure(code: number, log: string): string | null {
  const end = result(log);
  if (code !== 0) return `claude exited ${code}`;
  if (!end) return "claude ended without a result";
  if (end.is_error) return `claude ended with ${end.subtype}`;
  return null;
}

// ── Usage limits ───────────────────────────────────────────────────────────

/**
 * When a child that stopped on a usage limit can go on (epoch ms), or null when it hit none.
 * Reads only the last invocation (from its `init` event on): a resumed log keeps the old limit.
 * Prefers the structured `rate_limit_event`; falls back to the limit message's text.
 */
export function usageLimit(log: string, now: number, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const turn = log.slice(Math.max(0, log.lastIndexOf('"subtype":"init"')));
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
  const said = turn.match(/hit your (?:[\w-]+ )?limit · resets ([^"\\\n]+)|limit will reset at ([^"\\\n]+?)\.?(?:"|\\n|$)/m);
  if (!said && !rejected) return null;
  const reset = typeof resetsAt === "number" ? resetsAt * 1000 : said ? resetTime((said[1] ?? said[2]).trim(), now, zone) : null;
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

const DESIGN_OFF ={ "design@skills": false, "impeccable@impeccable": false };

/**
 * Arguments for a fresh child, or for resuming one whose session already exists.
 * `context` (a retry's answer from Jonas) follows the fresh prompt.
 */
export function claudeArgs(ticket: Ticket, session: { id: string; resume: boolean }, context = ""): string[] {
  const start = session.resume
    ? ["-p", "continue", "--resume", session.id]
    : ["-p", `/implement #${ticket.number}${context && `\n\n${context}`}`, "--session-id", session.id];
  // Non-ui tickets run without the design plugin, so its Stop "design deep pass"
  // hook and agents don't burn tokens on backend work. Both install ids: this
  // marketplace's and impeccable's own, if that is installed too.
  const design = ticket.labels.includes("ui") ? [] : ["--settings", JSON.stringify({ enabledPlugins: DESIGN_OFF })];
  // Headless -p denies anything needing approval unless a mode is set.
  return [...start, ...design, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "none"];
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
  const said = String(end?.result ?? "").trim();
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const head = why === NO_COMMIT && said ? "Claude stopped with a question:" : `The runner stopped on this ticket: ${why}.`;
  const last = said && why !== NO_COMMIT ? ["", "Claude's last message:", "", quote(said)] : said ? ["", quote(said)] : [];
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

/** Comments after the runner's last `needs-human` comment (`gh issue view --json comments`). */
export function answers(json: string): string {
  const bodies: string[] = JSON.parse(json).comments.map((c: any) => c.body);
  const mark = bodies.findLastIndex((b) => b.includes(NEEDS_HUMAN_MARK));
  return bodies.slice(mark + 1).join("\n\n---\n\n").trim();
}

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

  const sh = (cmd: string, args: string[], cwd = repo) => exec(cmd, args, { cwd });
  const must = async (cmd: string, args: string[], cwd = repo) => {
    const out = await sh(cmd, args, cwd);
    if (out.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${out.code}): ${out.stderr.trim()}`);
    return out.stdout.trim();
  };
  const worktree = (t: Ticket) => join(repo, ".worktrees", String(t.number));
  const logOf = (t: Ticket) => join(repo, ".worktrees/logs", `${t.number}.jsonl`);
  const branch = (t: Ticket) => `ticket/${t.number}`;

  // Setup: who claims, keep .worktrees/ out of the target repo's status, spec/<N> from main.
  const me = await must("gh", ["api", "user", "--jq", ".login"]);
  const specIssue = JSON.parse(await must("gh", ["issue", "view", String(spec), "--json", "title,url"]));
  const main = await must("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  await ignoreWorktrees();
  await must("git", ["fetch", "origin"]);
  if ((await sh("git", ["ls-remote", "--exit-code", "--heads", "origin", specBranch])).code !== 0) {
    await must("git", ["push", "origin", `origin/${main}:refs/heads/${specBranch}`]);
    await must("git", ["fetch", "origin"]);
    say(`Created ${specBranch} from ${main}`);
  }

  type Done = { ticket: Ticket; code: number };
  const running = new Map<number, Promise<Done>>();
  const waiting = new Map<number, { ticket: Ticket; pr: number; misses: number }>(); // PRs waiting on CI
  const merged: Merged[] = [];
  const stuck: Stuck[] = [];
  let tickets: Ticket[] = [];
  let labelReady: Promise<string> | undefined; // `needs-human` created once per run
  let pausedUntil = 0; // a usage limit: no child starts before then

  while (true) {
    tickets = children(await must("gh", ["api", `repos/{owner}/{repo}/issues/${spec}/sub_issues`, "--paginate", "--slurp"]));
    const prs = await openTicketPrs();
    const tracked = (t: Ticket) => running.has(t.number) || waiting.has(t.number) || stuck.some((s) => s.ticket.number === t.number);

    // Ours from an earlier run first (a PR waits on CI, otherwise its child (re)starts), then the frontier.
    const mine = tickets.filter((t) => t.open && t.assignees.includes(me) && !tracked(t));
    for (const t of mine.filter((t) => prs.has(t.number))) waiting.set(t.number, { ticket: t, pr: prs.get(t.number)!, misses: 0 });
    // A child that stopped on a usage limit is still ours and unfinished, so it's in `mine` and resumes here.
    const queue = [...mine.filter((t) => !prs.has(t.number)), ...frontier(tickets)];
    const paused = now() < pausedUntil;
    while (!paused && running.size < concurrency && queue.length) {
      const t = queue.shift()!;
      if (!t.assignees.includes(me)) await must("gh", ["issue", "edit", String(t.number), "--add-assignee", "@me"]);
      running.set(t.number, startChild(t));
    }

    if (running.size === 0 && waiting.size === 0 && !paused) break;
    if (await pollWaiting()) continue; // a merge may have unblocked tickets

    // React as soon as a child exits; wake for the next CI poll if a PR is waiting, or when a pause ends.
    const wake = Math.min(waiting.size ? POLL_MS : Infinity, paused ? pausedUntil - now() : Infinity);
    const poll = wake < Infinity ? deps.sleep(wake).then(() => null) : new Promise<null>(() => {});
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
    const exclude = resolve(repo, await must("git", ["rev-parse", "--git-path", "info/exclude"]));
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (/^\/?\.worktrees\/?$/m.test(text)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.worktrees/\n`);
  }

  async function openTicketPrs(): Promise<Map<number, number>> {
    const out = await must("gh", ["pr", "list", "--base", specBranch, "--state", "open", "--json", "number,headRefName", "--limit", "200"]);
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
      const exists = (await sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch(t)}`])).code === 0;
      await must("git", exists ? ["worktree", "add", dir, branch(t)] : ["worktree", "add", "-b", branch(t), dir, `origin/${specBranch}`]);
    }
    mkdirSync(dirname(logOf(t)), { recursive: true });
    const log = existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "";
    if (failure(0, log) === null) return { ticket: t, code: 0 }; // finished before a crash
    const id = sessionOf(log);
    say(`#${t.number}: ${id ? "resuming" : "starting"} claude in ${dir}`);
    const args = claudeArgs(t, id ? { id, resume: true } : { id: randomUUID(), resume: false }, context);
    const out = await exec("claude", args, { cwd: dir, log: logOf(t) });
    return { ticket: t, code: out.code };
  }

  /**
   * A ticket we gave up on earlier is takeable again: Jonas removed `needs-human`.
   * Drops the old worktree, keeps the old log aside, returns his answer for the fresh child.
   */
  async function retry(t: Ticket): Promise<string> {
    await sh("git", ["worktree", "remove", "--force", worktree(t)]);
    if (existsSync(logOf(t))) renameSync(logOf(t), logOf(t).replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
    const answer = answers(await must("gh", ["issue", "view", String(t.number), "--json", "comments"]));
    say(`#${t.number}: retrying after needs-human`);
    return answer && `This is a retry: the runner stopped on this ticket earlier. Jonas answered on the ticket:\n\n${answer}`;
  }

  /** A child exited: push its branch and open the ticket PR into spec/<N>. */
  async function publish({ ticket: t, code }: Done) {
    const log = existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "";
    const why = failure(code, log);
    const limit = why ? usageLimit(log, now()) : null;
    if (limit) return pause(t, limit);
    if (why) return giveUp(t, why);
    const ahead = Number(await must("git", ["rev-list", "--count", `origin/${specBranch}..${branch(t)}`], worktree(t)));
    if (!ahead) return giveUp(t, NO_COMMIT);
    await must("git", ["push", "-u", "origin", branch(t)], worktree(t));
    const body = `Ticket #${t.number} for spec #${spec}, built by the runner. The runner merges it and closes #${t.number}.`;
    const url = await must("gh", ["pr", "create", "--base", specBranch, "--head", branch(t), "--title", t.title, "--body", body]);
    const pr = Number(url.match(/\/pull\/(\d+)/)![1]);
    say(`#${t.number}: opened PR #${pr}`);
    waiting.set(t.number, { ticket: t, pr, misses: 0 });
  }

  /** A usage limit, not a failure: no child starts until the reset; the ticket stays ours and resumes then. */
  function pause(t: Ticket, until: number) {
    pausedUntil = Math.max(pausedUntil, until);
    say(`#${t.number}: usage limit, pausing children until ${new Date(pausedUntil).toLocaleString()}`);
  }

  /** Merges every waiting PR whose checks passed (all of them under --no-ci). True if any merged. */
  async function pollWaiting(): Promise<boolean> {
    let any = false;
    for (const w of [...waiting.values()]) {
      // Seam: #9 updates the ticket branch from the spec/<N> tip (and resolves conflicts) here.
      const state = ci ? checks(await sh("gh", ["pr", "checks", String(w.pr), "--json", "name,bucket"])) : "pass";
      if (state === "pending" || (state === "none" && ++w.misses < NO_CHECKS_GRACE)) continue;
      waiting.delete(w.ticket.number);
      if (state === "pass") any = (await merge(w.ticket, w.pr)) || any;
      else await giveUp(w.ticket, state === "fail" ? `CI failed on PR #${w.pr}` : `no CI checks on PR #${w.pr}`);
    }
    return any;
  }

  async function merge(t: Ticket, pr: number): Promise<boolean> {
    const out = await sh("gh", ["pr", "merge", String(pr), "--squash"]);
    if (out.code !== 0) {
      await giveUp(t, `merge of PR #${pr} failed: ${out.stderr.trim()}`);
      return false;
    }
    // Closing keywords only fire on the default branch, so close the ticket here.
    await must("gh", ["issue", "close", String(t.number), "--comment", `Merged in #${pr} into ${specBranch}.`]);
    await sh("git", ["worktree", "remove", "--force", worktree(t)]);
    await sh("git", ["branch", "-D", branch(t)]);
    await sh("git", ["push", "origin", "--delete", branch(t)]);
    t.open = false;
    merged.push({ ticket: t, pr });
    say(`#${t.number}: merged PR #${pr} into ${specBranch}`);
    await ensureSpecPr();
    return true;
  }

  type SpecPr = { number: number; state: string; isDraft: boolean };

  /** Draft spec/<N> → main, opened after the first merge. Any state counts, so a merged one isn't reopened. */
  async function ensureSpecPr(): Promise<SpecPr> {
    const out = await must("gh", ["pr", "list", "--head", specBranch, "--base", main, "--state", "all", "--json", "number,state,isDraft"]);
    const found: SpecPr[] = JSON.parse(out);
    if (found.length) return found[0];
    const body = specPrBody({ number: spec, url: specIssue.url }, tickets);
    const url = await must("gh", ["pr", "create", "--draft", "--base", main, "--head", specBranch, "--title", `Spec #${spec}: ${specIssue.title}`, "--body", body]);
    say(`Opened draft PR ${specBranch} → ${main}`);
    return { number: Number(url.match(/\/pull\/(\d+)/)![1]), state: "OPEN", isDraft: true };
  }

  /**
   * All tickets closed: one `/code-review` child on spec/<N> fixes what it can, the rest goes in
   * the PR body, then the PR is marked ready. Ready (or merged) means reviewed, so a rerun skips it;
   * an interrupted review resumes from its log. False if the review child failed.
   */
  async function reviewSpec(pr: SpecPr): Promise<boolean> {
    if (pr.state !== "OPEN" || !pr.isDraft) return true;
    const dir = join(repo, ".worktrees", `spec-${spec}`);
    const log = join(repo, ".worktrees/logs", `spec-${spec}-review.jsonl`);
    const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    const turns = [`/code-review ${specBranch}`, FIX_PROMPT];
    await must("git", ["fetch", "origin"]);
    if (!existsSync(dir)) await must("git", ["worktree", "add", "--detach", dir, `origin/${specBranch}`]);
    mkdirSync(dirname(log), { recursive: true });

    // Turns done = successful results in the log; a failed or killed turn is sent again.
    const results = () =>
      read().trim().split("\n").flatMap((l) => (l.includes('"type":"result"') ? [JSON.parse(l)] : [])).filter((r) => !r.is_error);
    const self: Ticket = { number: spec, title: specIssue.title, url: specIssue.url, open: true, assignees: [], labels: [], blockedBy: 0 };
    for (let turn = results().length; turn < turns.length; turn = results().length) {
      const id = sessionOf(read());
      say(`${specBranch}: ${turn ? "fixing review findings" : "reviewing"} in ${dir}`);
      const args = claudeArgs(self, id ? { id, resume: true } : { id: randomUUID(), resume: false });
      args[1] = turns[turn]; // same flags as a ticket child, the review's own prompt
      const out = await exec("claude", args, { cwd: dir, log });
      const why = failure(out.code, read());
      const limit = why ? usageLimit(read(), now()) : null;
      if (limit) {
        say(`${specBranch}: usage limit, review paused until ${new Date(limit).toLocaleString()}`);
        await deps.sleep(Math.max(0, limit - now()));
        continue; // the same turn again, resumed in its session
      }
      if (why) {
        say(`${specBranch}: review stopped: ${why}, log ${log}; the PR stays draft, rerun to resume`);
        return false;
      }
    }

    const ahead = Number(await must("git", ["rev-list", "--count", `origin/${specBranch}..HEAD`], dir));
    if (ahead) await must("git", ["push", "origin", `HEAD:refs/heads/${specBranch}`], dir);
    const unresolved = unresolvedFindings(results().at(-1)?.result ?? "");
    await must("gh", ["pr", "edit", String(pr.number), "--body", specPrBody({ number: spec, url: specIssue.url }, tickets, unresolved)]);
    await must("gh", ["pr", "ready", String(pr.number)]);
    await sh("git", ["worktree", "remove", "--force", dir]);
    say(`${specBranch}: reviewed (${ahead} fix commit(s), ${unresolved.length} unresolved); PR #${pr.number} ready`);
    return true;
  }

  /**
   * Hands a ticket to Jonas: comment (the question, or why + a log summary), `needs-human`, unassign.
   * Its worktree stays for inspection; removing the label makes it takeable again.
   */
  async function giveUp(t: Ticket, why: string) {
    stuck.push({ ticket: t, why, log: logOf(t) });
    say(`#${t.number}: stuck: ${why}`);
    const log = existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "";
    await must("gh", ["issue", "comment", String(t.number), "--body", needsHuman(why, log, { log: logOf(t), worktree: worktree(t) })]);
    labelReady ??= must("gh", ["label", "create", "needs-human", "--color", "D93F0B", "--description", "Runner stopped: needs Jonas", "--force"]);
    await labelReady;
    await must("gh", ["issue", "edit", String(t.number), "--add-label", "needs-human", "--remove-assignee", "@me"]);
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
