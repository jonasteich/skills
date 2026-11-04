# skills

Jonas Teichrüb's personal Claude Code setup, the **fleet**: a Claude Code plugin marketplace that bundles the upstream skills I use, trimmed to the ones I keep. Small wiring edits (handoffs between skills) land over time and are logged per plugin.

> **Personal setup. Use at your own risk.** It changes when my workflow changes, without notice or migration path. If you want the skills themselves, install them from their upstreams (below).

## Install

```
/plugin marketplace add jonasteich/skills
/plugin install engineering@skills
/plugin install workflow@skills
```

From a local clone: `/plugin marketplace add ~/Personal/skills`. Manifests carry no `version`, so an install tracks commits; pull changes with `/plugin marketplace update skills`.

## Plugins

| Plugin | Upstream | Pinned | License |
| --- | --- | --- | --- |
| `engineering` | [mattpocock/skills](https://github.com/mattpocock/skills) | `v1.3.1` | MIT © Matt Pocock ([LICENSE](plugins/engineering/LICENSE)) |
| `workflow` | own | n/a | MIT © Jonas Teichrüb ([LICENSE](plugins/workflow/LICENSE)) |

### `engineering`

Matt Pocock's engineering skills, vendored as a squashed `git subtree` at `plugins/engineering/`. Registered skills:

setup-matt-pocock-skills, wayfinder, grill-with-docs, grilling, domain-modeling, prototype, research, to-spec, to-tickets, implement, tdd, code-review, pr, codebase-design, improve-codebase-architecture, triage, diagnosing-bugs, wizard, retro, writing-for-agents.

The other upstream skills stay in the tree but are not registered, so they never load. Edits to upstream files are logged in [`plugins/engineering/CHANGES.md`](plugins/engineering/CHANGES.md).

### `workflow`

My own workflow tooling at `plugins/workflow/`.

Command-line tools, linked onto your PATH (`~/.local/bin`) by `plugins/workflow/bin/install` from a clone (they don't ship with `/plugin install`):

- [runner](plugins/workflow/bin/runner.ts): `runner <spec-issue> [--concurrency 2] [--no-ci]`, run inside a target repo's clone, builds a spec's tickets unattended into `spec/<N>`. Each open, unblocked, unassigned child ticket gets a worktree under `.worktrees/` and a headless `claude -p "/implement #N"`; the runner opens the ticket PR, waits for CI, squash-merges it into `spec/<N>`, closes the ticket and opens a draft `spec/<N>` → main PR. All state lives on GitHub (assignee = claim), so a rerun picks up where it stopped. GitHub Issues only; refuses a repo without CI unless `--no-ci`. Needs Node ≥ 23.6, `gh`, `git` and `claude`.

Registered skills:

- [workflow-retro](plugins/workflow/skills/workflow-retro/SKILL.md): `/workflow-retro [--since <date>] [--repo <path>]` reads session history, transcripts, runner logs and `needs-human` threads, and drafts one issue per recurring skill-chain friction on this repo (label `workflow-retro`). Nothing is filed without an OK.

## Credits

The `engineering` skills are the work of their upstream authors; this repo only selects and wires them. `workflow` is my own. Thanks to [Matt Pocock](https://github.com/mattpocock) for [mattpocock/skills](https://github.com/mattpocock/skills).

## Development

```
npm test
```

checks that the marketplace registers exactly the kept skills, the wiring edits, and the runner (unit tests at its gh/git/claude exec seam; CI runs them on every push to main and every PR). Maintenance rules are in [AGENTS.md](AGENTS.md).
