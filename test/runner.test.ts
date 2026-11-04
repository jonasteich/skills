// Runner unit tests. The runner talks to gh, git and claude only through its
// exec seam, so these tests feed it recorded outputs (test/fixtures/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checks, children, frontier, realExec, refusal, run, summary, updateFromSpec } from "../plugins/workflow/bin/runner.ts";
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

// ── Updating a ticket branch from spec/<N>, against real git ────────────────

/** An origin with spec/1, and a clone whose ticket/2 branched off it and changed f.txt's first line. */
async function ticketClone() {
  const root = mkdtempSync(join(tmpdir(), "runner-git-"));
  const git = async (cwd: string, ...args: string[]) => {
    const out = await realExec("git", ["-c", "init.defaultBranch=main", ...args], { cwd });
    assert.equal(out.code, 0, `git ${args.join(" ")}: ${out.stderr}`);
  };
  const clone = async (name: string, ...args: string[]) => {
    await git(root, "clone", "-q", ...args, "origin.git", name);
    await git(join(root, name), "config", "user.name", "t");
    await git(join(root, name), "config", "user.email", "t@t");
    return join(root, name);
  };
  const commit = async (cwd: string, text: string) => {
    writeFileSync(join(cwd, "f.txt"), text);
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", text.trim());
  };
  await git(root, "init", "-q", "--bare", "origin.git");
  const spec = await clone("spec");
  await commit(spec, "a\nb\nc\n");
  await git(spec, "push", "-q", "origin", "HEAD:spec/1");
  const ticket = await clone("ticket", "-b", "spec/1");
  await git(ticket, "checkout", "-qb", "ticket/2");
  await commit(ticket, "ticket 2\nb\nc\n");
  return {
    ticket,
    /** Another ticket merges into spec/1, changing f.txt to `text`. */
    advance: async (text: string) => {
      await commit(spec, text);
      await git(spec, "push", "-q", "origin", "HEAD:spec/1");
      await git(ticket, "fetch", "-q", "origin");
    },
  };
}

test("updateFromSpec: a branch already on the spec/<N> tip stays as it is", async () => {
  const { ticket } = await ticketClone();
  assert.deepEqual(await updateFromSpec(realExec, ticket, "spec/1"), { status: "current" });
});

test("updateFromSpec: merges a spec/<N> tip that touched other lines", async () => {
  const { ticket, advance } = await ticketClone();
  await advance("a\nb\nticket 3\n");
  assert.deepEqual(await updateFromSpec(realExec, ticket, "spec/1"), { status: "merged" });
  assert.equal(readFileSync(join(ticket, "f.txt"), "utf8"), "ticket 2\nb\nticket 3\n");
});

test("updateFromSpec: a conflict is left in the worktree, naming the files", async () => {
  const { ticket, advance } = await ticketClone();
  await advance("ticket 3\nb\nc\n");
  assert.deepEqual(await updateFromSpec(realExec, ticket, "spec/1"), { status: "conflict", files: ["f.txt"] });
  assert.match(readFileSync(join(ticket, "f.txt"), "utf8"), /^<<<<<<< /m);
});

// ── The loop, against a fake GitHub ─────────────────────────────────────────

type Issue = { number: number; title: string; state: "open" | "closed"; assignees: string[]; labels: string[] };
type Pr = { number: number; head: string; base: string; state: "open" | "merged"; draft?: boolean; body?: string };

/** A target repo on disk plus a fake gh/git/claude that keeps GitHub state. */
function fakeRepo(opts: {
  issues: Issue[];
  blockers?: Record<number, number[]>;
  prs?: Pr[];
  specBranch?: boolean;
  ci?: boolean;
  logs?: Record<number, string>;
  /** Answers a command before the defaults do; undefined falls through. */
  override?: (line: string, o: { cwd?: string; log?: string }, prs: Pr[]) => ReturnType<Exec> | undefined;
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
    const answer = opts.override?.(line, o, prs);
    if (answer) return answer;
    const has = (s: string) => line.includes(s);
    const num = (flagged: string) => Number(line.match(new RegExp(`${flagged} (\\d+)`))![1]);

    if (has("gh api user")) return ok("jonasteich\n");
    if (has("gh repo view")) return ok("main\n");
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
    if (has("git rev-parse --verify")) return { code: 1, stdout: "", stderr: "" };
    if (has("git rev-list --count")) return ok("1\n"); // the child committed
    if (cmd === "claude") {
      const id = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
      appendFileSync(o.log!, `{"type":"system","subtype":"init","session_id":"${id}"}\n`);
      appendFileSync(o.log!, `{"type":"result","subtype":"success","is_error":false,"session_id":"${id}"}\n`);
      return ok();
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

/**
 * #2 and #3 touch the same lines: once #2 merges, #3's branch conflicts with spec/1.
 * `resolves` says whether #3's resumed session clears the conflict.
 */
function sameLines(resolves: boolean) {
  let fixed = false;
  const res = (code: number, stdout = "", stderr = "") => Promise.resolve({ code, stdout, stderr });
  return fakeRepo({
    issues: [open(2), open(3)],
    override: (line, o, prs) => {
      const in3 = o.cwd?.endsWith(".worktrees/3");
      const behind = in3 && prs.some((p) => p.head === "ticket/2" && p.state === "merged");
      if (line.startsWith("git merge-base --is-ancestor")) return res(behind && !fixed ? 1 : 0);
      if (line.startsWith("git merge --no-edit") && in3) return res(1, "", "CONFLICT (content)");
      if (line.startsWith("git diff --name-only --diff-filter=U") && in3 && !fixed) return res(0, "f.txt\n");
      if (line.startsWith("git rev-parse -q --verify MERGE_HEAD")) return res(1);
      if (line.startsWith("claude ") && line.includes("--resume")) {
        fixed = resolves;
        const id = line.match(/--resume (\S+)/)![1];
        const end = resolves ? `"subtype":"success","is_error":false` : `"subtype":"error_during_execution","is_error":true`;
        appendFileSync(o.log!, `{"type":"result",${end},"session_id":"${id}"}\n`);
        return res(0);
      }
      return undefined;
    },
  });
}

test("run: a conflict with spec/<N> is resolved in the child's own session, then merged", async () => {
  const gh = sameLines(true);
  assert.equal(await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, deps(gh.exec)), 0);

  const claude = gh.calls.filter((c) => c.line.startsWith("claude "));
  const first = claude[1].line.match(/--session-id (\S+)/)![1];
  assert.equal(claude.length, 3, "one resolution run, no fresh session");
  assert.match(claude[2].line, new RegExp(`^claude -p .*conflict.* --resume ${first} `, "s"));
  assert.match(claude[2].line, /f\.txt/);
  assert.match(claude[2].line, /tests/);
  assert.equal(claude[2].cwd, join(gh.repo, ".worktrees/3"));

  const resolved = gh.calls.indexOf(claude[2]);
  const push = gh.calls.findIndex((c, i) => i > resolved && c.line === "git push origin ticket/3");
  const recheck = gh.calls.findIndex((c, i) => i > push && c.line.startsWith("gh pr checks 102"));
  assert.ok(push > 0 && recheck > push, "resolved branch pushed, then CI checked again");
  assert.ok(at(gh.calls, "gh pr merge 102") > recheck);
  assert.equal(gh.issues.get(3)!.state, "closed");
});

test("run: a conflict still failing after the resumed session leaves the ticket stuck, unmerged", async () => {
  const gh = sameLines(false);
  const said: string[] = [];
  const code = await run({ spec: 1, repo: gh.repo, ci: true, concurrency: 2 }, { ...deps(gh.exec), say: (m: string) => said.push(m) });

  assert.equal(code, 1);
  assert.equal(gh.calls.filter((c) => c.line.includes("--resume")).length, 1, "resolution tried once");
  assert.equal(at(gh.calls, "gh pr merge 102"), -1);
  assert.equal(at(gh.calls, "git push origin ticket/3"), -1);
  assert.equal(at(gh.calls, `worktree remove --force ${join(gh.repo, ".worktrees/3")}`), -1, "worktree kept for inspection");
  assert.equal(gh.issues.get(2)!.state, "closed");
  assert.equal(gh.issues.get(3)!.state, "open");
  assert.ok(said.some((m) => /#3: stuck: merging spec\/1 into ticket\/3 conflicted in f\.txt, still failing/.test(m)), said.join("\n"));
});
