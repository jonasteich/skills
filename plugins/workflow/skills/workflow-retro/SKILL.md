---
name: workflow-retro
description: "Turn skill-chain friction across many sessions into issues on jonasteich/skills."
disable-model-invocation: true
---

The user has asked for a **workflow retro**: look back over many sessions and find recurring **friction** in the skill chain (wayfinder / grill-with-docs → to-spec → to-tickets → implement, the runner, and the skills they call). Each finding becomes an issue on `jonasteich/skills`. `/retro` covers one session's environment; this covers how the skills hand off and hold up across sessions.

Args: `[--since <date>] [--repo <path>]`.

## Steps

1. **Window.** `--since` wins. Otherwise use the creation date of the newest `workflow-retro` issue, open or closed:

   ```
   gh issue list --repo jonasteich/skills --label workflow-retro --state all --limit 1 --json createdAt --jq '.[0].createdAt'
   ```

   No such issue (or no label yet): ask the user for a start date. Scope is every project, unless `--repo <path>` narrows it to that path and its worktrees. Done when you can state the window and scope in one line.

2. **Collect** every source in [Sources](#sources) for the window and scope. With more than ~20 sessions, fan out one subagent per project; each returns candidate friction with evidence refs, not transcripts. Done when every in-window session has been scanned for every [signal](#friction-signals), and every runner log and `needs-human` thread has been read.

3. **Cluster** candidates into findings: one finding per distinct cause, not per symptom. Keep a finding when it recurs in two or more sessions, or when a single occurrence cost a ticket (`needs-human`, a failed run, work redone). Drop friction that lies outside the skills (the repo's own code, tooling, CI): that belongs to `/retro`.

4. **Match** each finding against open issues:

   ```
   gh issue list --repo jonasteich/skills --label workflow-retro --state open --json number,title,body
   ```

   Same cause as an open issue → draft a **comment** on it carrying only the new Evidence. Otherwise draft a new issue in the [shape](#issue-shape).

5. **Show** all drafts (new issues and comments, numbered, in order of cost) and stop. File nothing until the user gives an explicit OK; they may approve a subset, edit, or drop drafts. Silence or a question is not an OK.

6. **File** the approved drafts. First make sure the label exists, creating it if missing:

   ```
   gh label list --repo jonasteich/skills --search workflow-retro --json name --jq '.[].name'
   gh label create workflow-retro --repo jonasteich/skills --color 5319e7 --description "Finding from /workflow-retro"
   ```

   Then `gh issue create --repo jonasteich/skills --label workflow-retro --title ... --body-file ...` per new issue, `gh issue comment <n> --repo jonasteich/skills --body-file ...` per comment. Report the links.

## Reference

### Sources

All timestamps are UTC. Formats as of Claude Code 2.1.x; if a field is missing, inspect a line with `jq` before assuming.

- **`~/.claude/history.jsonl`**: one line per prompt the user typed: `{display, pastedContents, timestamp, project, sessionId}`. `timestamp` is epoch **milliseconds**; `project` is the cwd. Use it as the index: which sessions fall in the window, in which project, and the user's own words (slash commands appear as `display` starting with `/`).
- **Transcripts**: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where `<encoded-cwd>` is the cwd with `/` and `.` replaced by `-` (so a worktree `…/skills/.claude/worktrees/x` is `-…-skills--claude-worktrees-x`). Subagent transcripts sit in `<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl`. Lines carry `type`, ISO `timestamp`, `cwd`, `gitBranch`, `message`. Skill use shows as a user message containing `<command-name>/plugin:skill</command-name>` (typed) or an assistant `tool_use` with `name: "Skill"` and `input.skill` (invoked by the agent).
- **Runner logs**: `<repo>/.worktrees/logs/<ticket>.jsonl`, one per `claude -p` child, for each project path in scope that has them.
- **`needs-human` threads**: the runner's question or failure comment, and the user's answer.

  ```
  gh search issues --owner jonasteich --label needs-human --updated ">=<since>" --json repository,number,url
  gh issue view <n> --repo <owner/repo> --comments
  ```

  The label is removed on retry, so also search `gh search issues --owner jonasteich "needs-human" --updated ">=<since>"` for threads that have since resumed.

### Friction signals

- **Missed handoff**: the user types the next skill by hand right after a skill ended, or asks "what next?".
- **Correction**: the user pushes back after a skill ran ("no", "again", "you forgot", "I said"), or interrupts (`[Request interrupted by user]`).
- **Repeat**: the same skill invoked twice on the same input, or the same instruction typed in several sessions (a step a skill should carry).
- **Dropped skill**: a skill this marketplace does not register, still being reached for (by name or from an old install).
- **Wrong context**: a skill ran without the doc it needed (`DESIGN.md`, the map, a ticket) or read the wrong one.
- **Runner stall**: `needs-human` questions a ticket or spec could have answered, merge conflicts, repeated failures on the same step.

### Issue shape

Title: the friction in a few words, as an observation ("to-tickets drops the `ui` label on design tickets").

```
## Finding

What goes wrong and what it costs, in two or three sentences.

## Evidence

- <date> · <project> · session <first 8 chars of sessionId>: "<short quote>"
- …

## Suggested edit

**Wiring** | **Rewrite** · `<skill>` · `plugins/<plugin>/skills/<path>/SKILL.md`

Sketch of the change.
```

- **Wiring** is an edit this repo makes (handoffs, which docs to read, labels to apply); log it per `AGENTS.md`. **Rewrite** changes what a skill does, so it belongs upstream or in an own plugin: say which.
- `jonasteich/skills` is **public**. Evidence quotes only skill-chain text; refer to non-personal projects by date and session id, with no client names, code, paths beyond the repo name, or secrets.
