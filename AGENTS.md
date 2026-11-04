# AGENTS.md

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Each upstream plugin is a squashed `git subtree` under `plugins/<name>/`.

## Registration

- Each marketplace entry is `strict: false` and lists its own kept `skills`. Upstream `plugin.json` stays untouched.
- An entry's `source` points at the subtree's `skills/` dir, not its root. The root holds upstream's `plugin.json`, whose own component list conflicts with a non-strict entry (the plugin fails to load) and whose `version` would pin installs.
- No `version` anywhere in our manifests: installs track commits.
- To drop a skill, remove it from the entry's `skills` list. Never delete upstream files: they stay in the tree, unregistered, so syncs don't conflict. New upstream skills stay invisible until added to the list.
- Keep `test/marketplace.test.js` in step with the kept/dropped lists, and run `node --test`.

## Syncing an upstream

Pinned to upstream **tags**, bumped deliberately. `rerere.enabled` is on in this clone (`git config rerere.enabled true` on a fresh clone) so resolved conflicts replay on the next sync.

```
git subtree pull --prefix=plugins/engineering https://github.com/mattpocock/skills <tag> --squash
```

Then update the pinned tag in `README.md`, check that no newly added upstream skill needs registering, and run `node --test`.

## Customizing

- **Wiring only.** Edits to upstream skills connect them: handoffs to the next skill, which docs to read, labels to apply. No rewrites of what a skill does. A rewrite belongs upstream or in an own plugin.
- Keep edits small and local, so subtree pulls merge cleanly.
- Log every edit in that plugin's `CHANGES.md`: one entry per edit with skill, what, why, upstream tag.
- **Apache-2.0 upstreams:** every modified file gets `<!-- Modified by Jonas Teichrüb, see CHANGES.md -->` at the top, and the upstream `LICENSE` and `NOTICE` stay in place. MIT upstreams: keep the `LICENSE`.
- No own hooks or agents, no dotfiles, no personal CLAUDE.md in this repo.
