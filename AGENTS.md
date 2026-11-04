# AGENTS.md

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Each upstream plugin is a squashed `git subtree` under `plugins/<name>/`.

## Registration

- Each marketplace entry is `strict: false` and lists its own kept `skills`. Upstream `plugin.json` stays untouched.
- An entry's `source` points at the subtree's `skills/` dir, not its root. The root holds upstream's `plugin.json`, whose own component list conflicts with a non-strict entry (the plugin fails to load) and whose `version` would pin installs.
- No `version` anywhere in our manifests: installs track commits.
- To drop a skill, remove it from the entry's `skills` list. Never delete upstream files: they stay in the tree, unregistered, so syncs don't conflict. New upstream skills stay invisible until added to the list.
- The kept list lives in three places: the entry's `skills`, `test/marketplace.test.js` (kept and dropped lists) and `README.md`. Change all three together, then run `npm test`. The test fails on any upstream skill that is on neither list.
- `source` is `skills/`, so the installed copy only holds what's under it: keep a copy of upstream's `LICENSE` at `plugins/<name>/skills/LICENSE` (refresh it on sync).

## Syncing an upstream

Pinned to upstream **tags**, bumped deliberately. `rerere.enabled` is on in this clone (`git config rerere.enabled true` on a fresh clone) so resolved conflicts replay on the next sync.

```
git subtree pull --prefix=plugins/engineering https://github.com/mattpocock/skills <tag> --squash
```

Then refresh `skills/LICENSE` from the subtree's `LICENSE`, update the pinned tag in `README.md` and `CHANGES.md`, and run `npm test`: it names any new upstream skill to put on the kept or dropped list.

## Customizing

- **Wiring only.** Edits to upstream skills connect them: handoffs to the next skill, which docs to read, labels to apply. No rewrites of what a skill does. A rewrite belongs upstream or in an own plugin.
- Keep edits small and local, so subtree pulls merge cleanly.
- Log every edit in that plugin's `CHANGES.md`: one entry per edit with skill, what, why, upstream tag.
- **Apache-2.0 upstreams:** every modified file gets `<!-- Modified by Jonas Teichrüb, see CHANGES.md -->` at the top, and the upstream `LICENSE` and `NOTICE` stay in place. MIT upstreams: keep the `LICENSE`.
- No own hooks or agents, no personal dotfiles, no personal CLAUDE.md in this repo.
