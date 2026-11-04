// Runner unit tests. The runner talks to gh, git and claude only through its
// exec seam, so these tests feed it recorded outputs (test/fixtures/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checks, children, clean, frontier, refusal, run, summary } from "../plugins/workflow/bin/runner.ts";
import type { Exec } from "../plugins/workflow/bin/runner.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

test("frontier: open, unblocked, unassigned children not waiting on a human", () => {
  const snapshot = children(fixture("sub_issues.json"));
  assert.deepEqual(frontier(snapshot).map((t) => t.number), [2, 6]);
});

const github = "# Issue tracker: GitHub\n\nIssues live on GitHub.\n";
const local = "# Issue tracker: Local Markdown\n\nIssues live in .scratch/.\n";

test("refuses a local-markdown tracker", () => {
  const why = refusal({ tracker: local, scratch: true, ci: true }, { ci: true });
  assert.match(why!, /GitHub Issues only/);
  assert.match(why!, /Local Markdown/);
});

test("refuses a repo with only a .scratch/ tracker and no tracker doc", () => {
  assert.match(refusal({ tracker: null, scratch: true, ci: true }, { ci: true })!, /GitHub Issues only/);
});

test("refuses a repo without CI unless --no-ci", () => {
  assert.match(refusal({ tracker: github, scratch: false, ci: false }, { ci: true })!, /--no-ci/);
  assert.equal(refusal({ tracker: github, scratch: false, ci: false }, { ci: false }), null);
});

test("accepts a GitHub-tracked repo with CI", () => {
  assert.equal(refusal({ tracker: github, scratch: false, ci: true }, { ci: true }), null);
});

test("checks: reads gh pr checks output, treating 'no checks yet' apart from failure", () => {
  const out = (code: number, stdout: string, stderr = "") => ({ code, stdout, stderr });
  const json = (...buckets: string[]) => JSON.stringify(buckets.map((bucket) => ({ name: "t", bucket })));
  assert.equal(checks(out(0, json("pass", "skipping"))), "pass");
  assert.equal(checks(out(8, json("pass", "pending"))), "pending");
  assert.equal(checks(out(1, json("pass", "fail"))), "fail");
  assert.equal(checks(out(1, json("cancel"))), "fail");
  assert.equal(checks(out(1, "", "no checks reported on the 'ticket/2' branch\n")), "none");
});

test("summary: lists merged, stuck and still-open tickets with links", () => {
  const [two, three, four, , , seven] = children(fixture("sub_issues.json"));
  const text = summary([{ ticket: { ...two, open: false }, pr: 100 }], [{ ticket: four, why: "CI failed on PR #101", log: ".worktrees/logs/4.jsonl" }], [two, three, four, seven]);
  assert.equal(
    text,
    [
      "Merged (1):",
      "  #2 Ready ticket: PR #100 (https://github.com/o/r/issues/2)",
      "Stuck (1):",
      "  #4 Claimed by a runner: CI failed on PR #101, log .worktrees/logs/4.jsonl (https://github.com/o/r/issues/4)",
      "Still open (2):",
      "  #3 Blocked by #2: blocked (https://github.com/o/r/issues/3)",
      "  #7 Waiting on Jonas: needs-human (https://github.com/o/r/issues/7)",
    ].join("\n"),
  );
});

// ── The loop, against a fake GitHub ─────────────────────────────────────────

type Issue = { number: number; title: string; state: "open" | "closed"; assignees: string[]; labels: string[]; comments?: string[] };
/** How a fake child ends: done (it committed), fail, or ask (ends with a question, no commit). */
type Child = "done" | "fail" | { ask: string };
type Pr = { number: number; head: string; base: string; state: "open" | "merged"; draft?: boolean; body?: string };

/** A target repo on disk plus a fake gh/git/claude that keeps GitHub state. */
function fakeRepo(opts: {
  issues: Issue[];
  blockers?: Record<number, number[]>;
  prs?: Pr[];
  specBranch?: boolean;
  ci?: boolean;
  logs?: Record<number, string>;
  child?: Record<number, Child>;
}) {
  const repo = mkdtempSync(join(tmpdir(), "runner-"));
  mkdirSync(join(repo, "docs/agents"), { recursive: true });
  writeFileSync(join(repo, "docs/agents/issue-tracker.md"), github);
  if (opts.ci ?? true) {
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: [pull_request]\n");
  }
  for (const [n, text] of Object.entries(opts.logs ?? {})) {
    mkdirSync(join(repo, ".worktrees/logs"), { recursive: true });
    mkdirSync(join(repo, `.worktrees/${n}`), { recursive: true });
    writeFileSync(join(repo, `.worktrees/logs/${n}.jsonl`), text);
  }

  const issues = new Map(opts.issues.map((i) => [i.number, i]));
  const prs = [...(opts.prs ?? [])];
  let specBranch = opts.specBranch ?? false;
  const calls: { line: string; cwd?: string }[] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const openBlockers = (n: number) =>
    (opts.blockers?.[n] ?? []).filter((b) => issues.get(b)!.state === "open").length;

  const exec: Exec = async (cmd, args, o = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, cwd: o.cwd });
    const has = (s: string) => line.includes(s);
    const num = (flagged: string) => Number(line.match(new RegExp(`${flagged} (\\d+)`))![1]);

    if (has("gh api user")) return ok("jonasteich\n");
    if (has("gh repo view")) return ok("main\n");
    if (has("gh issue view") && has("--json comments")) {
      const comments = (issues.get(num("view"))!.comments ?? []).map((body) => ({ body }));
      return ok(JSON.stringify({ comments }));
    }
    if (has("gh issue view")) return ok(JSON.stringify({ title: "The spec", url: "https://github.com/o/r/issues/1" }));
    if (has("/sub_issues")) {
      const page = [...issues.values()].map((i) => ({
        number: i.number, title: i.title, state: i.state, html_url: `https://github.com/o/r/issues/${i.number}`,
        assignees: i.assignees.map((login) => ({ login })), labels: i.labels.map((name) => ({ name })),
        issue_dependencies_summary: { blocked_by: openBlockers(i.number) },
      }));
      return ok(JSON.stringify([page]));
    }
    if (has("gh issue edit") && has("--add-assignee @me")) {
      issues.get(num("edit"))!.assignees.push("jonasteich");
      return ok();
    }
    if (has("gh issue edit")) {
      const issue = issues.get(num("edit"))!;
      if (has("--add-label needs-human")) issue.labels.push("needs-human");
      if (has("--remove-assignee @me")) issue.assignees = issue.assignees.filter((a) => a !== "jonasteich");
      return ok();
    }
    if (has("gh issue comment")) {
      (issues.get(num("comment"))!.comments ??= []).push(args[args.indexOf("--body") + 1]);
      return ok();
    }
    if (has("gh issue close")) {
      issues.get(num("close"))!.state = "closed";
      return ok();
    }
    if (has("gh pr list")) {
      const base = line.match(/--base (\S+)/)![1];
      const head = line.match(/--head (\S+)/)?.[1];
      const found = prs.filter((p) => p.state === "open" && p.base === base && (!head || p.head === head));
      return ok(JSON.stringify(found.map((p) => ({ number: p.number, headRefName: p.head }))));
    }
    if (has("gh pr create")) {
      const pr: Pr = {
        number: 100 + prs.length, head: line.match(/--head (\S+)/)![1], base: line.match(/--base (\S+)/)![1],
        state: "open", draft: has("--draft"), body: args[args.indexOf("--body") + 1],
      };
      prs.push(pr);
      return ok(`https://github.com/o/r/pull/${pr.number}\n`);
    }
    if (has("gh pr checks")) return ok(JSON.stringify([{ name: "test", bucket: "pass" }]));
    if (has("gh pr merge")) {
      prs.find((p) => p.number === num("merge"))!.state = "merged";
      return ok();
    }
    if (has("git ls-remote")) return { code: specBranch ? 0 : 2, stdout: "", stderr: "" };
    if (has("git push origin origin/main:refs/heads/spec/1")) {
      specBranch = true;
      return ok();
    }
    if (has("git rev-parse --git-path info/exclude")) return ok(".git/info/exclude\n");
    if (has("git worktree remove")) {
      rmSync(args[3], { recursive: true, force: true });
      return ok();
    }
    if (has("git rev-parse --verify"))return { code: 1, stdout: "", stderr: "" };
    const childOf = (cwd?: string) => opts.child?.[Number(cwd?.match(/\/(\d+)$/)?.[1])] ?? "done";
    if (has("git rev-list --count")) return ok(childOf(o.cwd) === "done" ? "1\n" : "0\n");
    if (cmd === "claude") {
      const id = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
      const child = childOf(o.cwd);
      const end =
        child === "fail"
          ? { subtype: "error_during_execution", is_error: true, result: "Tests kept failing", num_turns: 12 }
          : { subtype: "success", is_error: false, result: child === "done" ? "Done." : child.ask, num_turns: 3 };
      appendFileSync(o.log!, `{"type":"system","subtype":"init","session_id":"${id}"}\n`);
      appendFileSync(o.log!, JSON.stringify({ type: "result", ...end, permission_denials: [], session_id: id }) + "\n");
      return { code: child === "fail" ? 1 : 0, stdout: "", stderr: "" };
    }
    return ok();
  };
  return { repo, exec, calls, issues, prs };
}

const deps = (exec: Exec) => ({ exec, sleep: async () => {}, say: () => {} });
const open = (number: number, assignees: string[] = []): Issue => ({
  number, title: `Ticket ${number}`, state: "open", assignees, labels: [],
});
const at = (calls: { line: string }[], text: string) => calls.findIndex((c) => c.line.includes(text));

test("run: builds the frontier into spec/<N>, unblocking as tickets merge", async () => {
  const gh = fakeRepo({ issues: [open(2), open(3)], blockers: { 3: [2] } });
  const code = await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec));

  assert.equal(code, 0);
  assert.ok(at(gh.calls, "git push origin origin/main:refs/heads/spec/1") >= 0, "spec branch not created from main");
  const claude = gh.calls.filter((c) => c.line.startsWith("claude "));
  assert.deepEqual(claude.map((c) => c.cwd), [join(gh.repo, ".worktrees/2"), join(gh.repo, ".worktrees/3")]);
  assert.match(claude[0].line, /^claude -p \/implement #2 --session-id [0-9a-f-]{36} /);
  assert.ok(existsSync(join(gh.repo, ".worktrees/logs/2.jsonl")), "child log missing");
  assert.ok(at(gh.calls, "gh pr merge 100") < gh.calls.indexOf(claude[1]), "#3 started before its blocker merged");

  const ticketPrs = gh.prs.filter((p) => p.head.startsWith("ticket/"));
  assert.deepEqual(ticketPrs.map((p) => [p.head, p.base, p.state]), [
    ["ticket/2", "spec/1", "merged"],
    ["ticket/3", "spec/1", "merged"],
  ]);
  assert.equal(gh.issues.get(2)!.state, "closed");
  assert.equal(gh.issues.get(3)!.state, "closed");

  const specPrs = gh.prs.filter((p) => p.head === "spec/1");
  assert.equal(specPrs.length, 1, "draft spec PR opened once");
  assert.equal(specPrs[0].base, "main");
  assert.ok(specPrs[0].draft);
  assert.match(specPrs[0].body!, /Closes #1, #2, #3/);
  assert.match(readFileSync(join(gh.repo, ".git/info/exclude"), "utf8"), /^\.worktrees\/$/m);
});

test("run: a rerun after a crash picks up where it stopped", async () => {
  const gh = fakeRepo({
    issues: [open(2, ["jonasteich"]), open(4, ["jonasteich"]), open(6, ["jonasteich"]), open(8, ["someone"])],
    prs: [{ number: 50, head: "ticket/2", base: "spec/1", state: "open" }],
    specBranch: true,
    logs: {
      // #4's child was killed mid-turn; #6's child finished but its PR wasn't opened yet.
      4: `{"type":"system","subtype":"init","session_id":"aaaaaaaa-0000-4000-8000-000000000004"}\n`,
      6: `{"type":"system","subtype":"init","session_id":"s6"}\n{"type":"result","subtype":"success","is_error":false}\n`,
    },
  });
  const code = await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec));

  assert.equal(code, 1, "#8 is someone else's, so the spec isn't done");
  const claude = gh.calls.filter((c) => c.line.startsWith("claude "));
  assert.equal(claude.length, 1, "only the interrupted child reruns");
  assert.match(claude[0].line, /^claude -p continue --resume aaaaaaaa-0000-4000-8000-000000000004 /);
  assert.equal(at(gh.calls, "--add-assignee"), -1, "nothing new to claim");
  assert.equal(at(gh.calls, "git push origin origin/main"), -1, "spec branch already exists");
  assert.equal(gh.prs.find((p) => p.number === 50)!.state, "merged");
  for (const n of [2, 4, 6]) assert.equal(gh.issues.get(n)!.state, "closed", `#${n} not closed`);
  assert.equal(gh.issues.get(8)!.state, "open");
});

test("run --no-ci: merges once the child is done, without waiting on checks", async () => {
  const gh = fakeRepo({ issues: [open(2)], ci: false });
  assert.equal(await run({ spec: 1, repo: gh.repo, ci: false, concurrency: 2 }, deps(gh.exec)), 0);
  assert.equal(at(gh.calls, "gh pr checks"), -1);
  assert.equal(gh.issues.get(2)!.state, "closed");
});

test("run: refuses before touching GitHub", async () => {
  const gh = fakeRepo({ issues: [open(2)], ci: false });
  assert.equal(await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec)), 2);
  assert.deepEqual(gh.calls, []);
});

test("run: a failing child gets needs-human, the others keep running", async () => {
  const gh = fakeRepo({ issues: [open(2), open(3)], child: { 2: "fail" } });
  const code = await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec));

  assert.equal(code, 1, "#2 is stuck");
  const two = gh.issues.get(2)!;
  assert.deepEqual([two.state, two.labels, two.assignees], ["open", ["needs-human"], []]);
  assert.equal(two.comments?.length, 1);
  assert.match(two.comments![0], /claude exited 1/);
  assert.match(two.comments![0], /Tests kept failing/);
  assert.ok(two.comments![0].includes(join(gh.repo, ".worktrees/logs/2.jsonl")), "comment links the log");
  assert.ok(at(gh.calls, "gh label create needs-human") >= 0, "label created if missing");
  assert.ok(at(gh.calls, "gh label create needs-human") < at(gh.calls, "--add-label needs-human"));
  const removed = gh.calls.filter((c) => c.line.includes("worktree remove")).map((c) => c.line);
  assert.deepEqual(removed, [`git worktree remove --force ${join(gh.repo, ".worktrees/3")}`], "#2's worktree kept");
  assert.equal(gh.issues.get(3)!.state, "closed", "#3 still merged");
});

test("run: a child that asks a question puts the question on the ticket", async () => {
  const gh = fakeRepo({ issues: [open(2)], child: { 2: { ask: "Should the label be red\nor orange?" } } });
  await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec));

  const [comment] = gh.issues.get(2)!.comments!;
  assert.match(comment, /Claude stopped with a question:\n\n> Should the label be red\n> or orange\?/);
  assert.deepEqual(gh.issues.get(2)!.labels, ["needs-human"]);
  assert.equal(at(gh.calls, "gh pr create --base spec/1"), -1, "no PR without a commit");
});

test("run: removing needs-human retries the ticket fresh, with Jonas's answer as context", async () => {
  const gh = fakeRepo({
    issues: [{ ...open(2), comments: ["Earlier chatter", "<!-- runner:needs-human -->\nClaude stopped with a question:\n\n> Red or orange?", "Orange, please."] }],
    logs: { 2: `{"type":"system","subtype":"init","session_id":"old-session"}\n{"type":"result","subtype":"success","is_error":false,"result":"Red or orange?"}\n` },
    specBranch: true,
  });
  assert.equal(await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec)), 0);

  const removed = at(gh.calls, `git worktree remove --force ${join(gh.repo, ".worktrees/2")}`);
  const claude = gh.calls.filter((c) => c.line.startsWith("claude "));
  assert.ok(removed >= 0 && removed < gh.calls.indexOf(claude[0]), "old worktree removed before the retry");
  assert.equal(claude.length, 1);
  assert.match(claude[0].line, /^claude -p \/implement #2\n[^]*Orange, please\.[^]* --session-id [0-9a-f-]{36} /);
  assert.doesNotMatch(claude[0].line, /Earlier chatter|old-session/);
  assert.doesNotMatch(readFileSync(join(gh.repo, ".worktrees/logs/2.jsonl"), "utf8"), /old-session/, "fresh log");
  assert.equal(gh.issues.get(2)!.state, "closed");
});

test("clean: removes leftover ticket worktrees, keeps the logs", async () => {
  const gh = fakeRepo({ issues: [], logs: { 2: "{}\n", 5: "{}\n" } });
  assert.equal(await clean(gh.repo, deps(gh.exec)), 0);

  const git = gh.calls.filter((c) => c.line.startsWith("git worktree")).map((c) => c.line);
  assert.deepEqual(git, [
    `git worktree remove --force ${join(gh.repo, ".worktrees/2")}`,
    `git worktree remove --force ${join(gh.repo, ".worktrees/5")}`,
    "git worktree prune",
  ]);
  assert.deepEqual(readdirSync(join(gh.repo, ".worktrees")), ["logs"]);
  assert.deepEqual(readdirSync(join(gh.repo, ".worktrees/logs")).sort(), ["2.jsonl", "5.jsonl"]);
});
