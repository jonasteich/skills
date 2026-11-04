#!/usr/bin/env node
// runner <spec-issue> [--concurrency 2] [--no-ci]
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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
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
// Seams: #10 tells a usage limit (pause, then resume) apart from a failure here.
export function failure(code: number, log: string): string | null {
  const end = result(log);
  if (code !== 0) return `claude exited ${code}`;
  if (!end) return "claude ended without a result";
  if (end.is_error) return `claude ended with ${end.subtype}`;
  return null;
}

const DESIGN_OFF = { "design@skills": false, "impeccable@impeccable": false };

/** Arguments for a fresh child, or for resuming one whose session already exists. */
export function claudeArgs(ticket: Ticket, session: { id: string; resume: boolean; prompt?: string }): string[] {
  const start = session.resume
    ? ["-p", session.prompt ?? "continue", "--resume", session.id]
    : ["-p", `/implement #${ticket.number}`, "--session-id", session.id];
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

export type Deps = { exec: Exec; sleep: (ms: number) => Promise<unknown>; say: (msg: string) => void };
export type Options = { spec: number; repo: string; ci: boolean; concurrency: number };

// ── The loop ───────────────────────────────────────────────────────────────

/** Works the spec until nothing is takeable. Exit code: 0 all done, 1 tickets left, 2 refused. */
export async function run(opts: Options, deps: Deps): Promise<number> {
  const { spec, repo, ci, concurrency } = opts;
  const { exec, say } = deps;
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

  while (true) {
    tickets = children(await must("gh", ["api", `repos/{owner}/{repo}/issues/${spec}/sub_issues`, "--paginate", "--slurp"]));
    const prs = await openTicketPrs();
    const tracked = (t: Ticket) => running.has(t.number) || waiting.has(t.number) || stuck.some((s) => s.ticket.number === t.number);

    // Ours from an earlier run first (a PR waits on CI, otherwise its child (re)starts), then the frontier.
    const mine = tickets.filter((t) => t.open && t.assignees.includes(me) && !tracked(t));
    for (const t of mine.filter((t) => prs.has(t.number))) waiting.set(t.number, { ticket: t, pr: prs.get(t.number)!, misses: 0 });
    const queue = [...mine.filter((t) => !prs.has(t.number)), ...frontier(tickets)];
    while (running.size < concurrency && queue.length) {
      const t = queue.shift()!;
      if (!t.assignees.includes(me)) await must("gh", ["issue", "edit", String(t.number), "--add-assignee", "@me"]);
      running.set(t.number, startChild(t));
    }

    if (running.size === 0 && waiting.size === 0) break;
    if (await pollWaiting()) continue; // a merge may have unblocked tickets
    if (running.size === 0 && waiting.size === 0) continue; // the last waiting PR got stuck: nothing left to wait on

    // React as soon as a child exits; wake for the next CI poll only if a PR is waiting.
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
    if (!existsSync(dir)) {
      const exists = (await sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch(t)}`])).code === 0;
      await must("git", exists ? ["worktree", "add", dir, branch(t)] : ["worktree", "add", "-b", branch(t), dir, `origin/${specBranch}`]);
    }
    mkdirSync(dirname(logOf(t)), { recursive: true });
    const log = existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "";
    if (failure(0, log) === null) return { ticket: t, code: 0 }; // finished before a crash
    const id = sessionOf(log);
    say(`#${t.number}: ${id ? "resuming" : "starting"} claude in ${dir}`);
    const args = claudeArgs(t, id ? { id, resume: true } : { id: randomUUID(), resume: false });
    const out = await exec("claude", args, { cwd: dir, log: logOf(t) });
    return { ticket: t, code: out.code };
  }

  /** A child exited: push its branch and open the ticket PR into spec/<N>. */
  async function publish({ ticket: t, code }: Done) {
    const why = failure(code, existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "");
    if (why) return giveUp(t, why);
    const ahead = Number(await must("git", ["rev-list", "--count", `origin/${specBranch}..${branch(t)}`], worktree(t)));
    if (!ahead) return giveUp(t, "claude finished without committing");
    await must("git", ["push", "-u", "origin", branch(t)], worktree(t));
    const body = `Ticket #${t.number} for spec #${spec}, built by the runner. The runner merges it and closes #${t.number}.`;
    const url = await must("gh", ["pr", "create", "--base", specBranch, "--head", branch(t), "--title", t.title, "--body", body]);
    const pr = Number(url.match(/\/pull\/(\d+)/)![1]);
    say(`#${t.number}: opened PR #${pr}`);
    waiting.set(t.number, { ticket: t, pr, misses: 0 });
  }

  /** Merges every waiting PR whose checks passed (all of them under --no-ci). True if any merged. */
  async function pollWaiting(): Promise<boolean> {
    let any = false;
    for (const w of [...waiting.values()]) {
      const state = ci ? checks(await sh("gh", ["pr", "checks", String(w.pr), "--json", "name,bucket"])) : "pass";
      if (state === "pending" || (state === "none" && ++w.misses < NO_CHECKS_GRACE)) continue;
      waiting.delete(w.ticket.number);
      if (state !== "pass") {
        giveUp(w.ticket, state === "fail" ? `CI failed on PR #${w.pr}` : `no CI checks on PR #${w.pr}`);
        continue;
      }
      const update = await updateTicket(w.ticket);
      if (update === "stuck") continue;
      // The updated branch needs green CI again before it merges.
      if (update === "pushed" && ci) waiting.set(w.ticket.number, { ...w, misses: 0 });
      else any = (await merge(w.ticket, w.pr)) || any;
    }
    return any;
  }

  /** Brings the ticket branch up to the spec/<N> tip; a conflict goes back to the child's own session, once. */
  async function updateTicket(t: Ticket): Promise<"current" | "pushed" | "stuck"> {
    const dir = worktree(t);
    await must("git", ["fetch", "origin"]);
    if (!existsSync(dir)) await must("git", ["worktree", "add", "-B", branch(t), dir, `origin/${branch(t)}`]);
    const update = await updateFromSpec(exec, dir, specBranch);
    if (update.status === "current") return "current";
    const why = update.status === "failed" ? update.why : update.status === "conflict" ? await resolveConflict(t, update.files) : null;
    if (why) {
      giveUp(t, why);
      return "stuck";
    }
    await must("git", ["push", "origin", branch(t)], dir);
    say(`#${t.number}: updated ${branch(t)} from ${specBranch}`);
    return "pushed";
  }

  /** Resumes the ticket's session to resolve the conflicted merge and rerun tests. Why it didn't, or null. */
  async function resolveConflict(t: Ticket, files: string[]): Promise<string | null> {
    const log = () => (existsSync(logOf(t)) ? readFileSync(logOf(t), "utf8") : "");
    const id = sessionOf(log());
    const conflict = `merging ${specBranch} into ${branch(t)} conflicted in ${files.join(", ")}`;
    if (!id) return `${conflict}, and there's no session to resume`;
    say(`#${t.number}: ${conflict}; resuming claude to resolve it`);
    const prompt = `Merging origin/${specBranch} into this branch conflicted in: ${files.join(", ")}. ` +
      "Resolve the conflicts so both sides' changes still work, rerun the tests until they pass, and commit the merge.";
    const out = await exec("claude", claudeArgs(t, { id, resume: true, prompt }), { cwd: worktree(t), log: logOf(t) });
    const why = failure(out.code, log()) ?? (await unmerged(exec, worktree(t)));
    return why && `${conflict}, still failing after the resumed session: ${why}`;
  }

  async function merge(t: Ticket, pr: number): Promise<boolean> {
    const out = await sh("gh", ["pr", "merge", String(pr), "--squash"]);
    if (out.code !== 0) {
      giveUp(t, `merge of PR #${pr} failed: ${out.stderr.trim()}`);
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

  /** Stops working a ticket for this run; its worktree stays for inspection. */
  // Seam: #8 comments the reason + log summary, labels needs-human and unassigns.
  function giveUp(t: Ticket, why: string) {
    stuck.push({ ticket: t, why, log: logOf(t) });
    say(`#${t.number}: stuck: ${why}`);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const usage = "usage: runner <spec-issue> [--concurrency 2] [--no-ci]";

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: { ci: { type: "boolean", default: true }, concurrency: { type: "string", default: "2" } },
  });
  const spec = Number(positionals[0]);
  const concurrency = Number(values.concurrency);
  // Seam: #8 adds `runner clean`.
  if (positionals.length !== 1 || !Number.isInteger(spec) || !(concurrency >= 1)) {
    console.error(usage);
    return 2;
  }
  const top = await realExec("git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    console.error("runner: run it inside the target repo's clone");
    return 2;
  }
  const deps: Deps = { exec: realExec, sleep, say: (msg) => console.error(msg) };
  return run({ spec, repo: top.stdout.trim(), ci: values.ci!, concurrency }, deps);
}

// import.meta.main needs Node 24.2; compare paths so Node 23.6+ works too (bin/runner is a symlink).
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
