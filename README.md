# skills

Jonas Teichrüb's personal Claude Code setup, the **fleet**: a Claude Code plugin marketplace that bundles the upstream skills I use, trimmed to the ones I keep and wired to hand off to each other.

> **Personal setup. Use at your own risk.** It changes when my workflow changes, without notice or migration path. If you want the skills themselves, install them from their upstreams (below).

## Install

```
/plugin marketplace add jonasteich/skills
/plugin install engineering@skills
```

From a local clone: `/plugin marketplace add ~/Personal/skills`. Manifests carry no `version`, so an install tracks commits; pull changes with `/plugin marketplace update skills`.

## Plugins

| Plugin | Upstream | Pinned | License |
| --- | --- | --- | --- |
| `engineering` | [mattpocock/skills](https://github.com/mattpocock/skills) | `v1.3.1` | MIT © Matt Pocock ([LICENSE](plugins/engineering/LICENSE)) |

### `engineering`

Matt Pocock's engineering skills, vendored as a squashed `git subtree` at `plugins/engineering/`. Registered skills:

setup-matt-pocock-skills, wayfinder, grill-with-docs, grilling, domain-modeling, prototype, research, to-spec, to-tickets, implement, tdd, code-review, pr, codebase-design, improve-codebase-architecture, triage, diagnosing-bugs, wizard, retro, writing-for-agents.

The other upstream skills stay in the tree but are not registered, so they never load. Edits to upstream files are logged in [`plugins/engineering/CHANGES.md`](plugins/engineering/CHANGES.md).

## Credits

All skills here are the work of their upstream authors; this repo only selects and wires them. Thanks to [Matt Pocock](https://github.com/mattpocock) for [mattpocock/skills](https://github.com/mattpocock/skills).

## Development

```
node --test
```

checks that the marketplace registers exactly the kept skills. Maintenance rules are in [AGENTS.md](AGENTS.md).
