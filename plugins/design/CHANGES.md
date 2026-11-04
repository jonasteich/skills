# Changes to pbakaus/impeccable

Edits made in this fork of [pbakaus/impeccable](https://github.com/pbakaus/impeccable)'s Claude Code plugin (Apache-2.0 © 2025 Paul Bakaus, see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md)). One entry per edit.

Format: `### <skill>: <what>` then **Why** and **Upstream tag**. Every modified upstream file gets `<!-- Modified by Jonas Teichrüb, see CHANGES.md -->` at the top.

Vendored at `skill-v4.3.1`: upstream's `plugin/` dir, extracted with `git subtree split --prefix=plugin` and added as a squashed subtree. Registered in the repo's `.claude-plugin/marketplace.json` as a strict entry over this dir, so upstream's `plugin.json` supplies the skill, agents and hooks as shipped.

`LICENSE` and `NOTICE.md` are added copies of upstream's repo-root files (the split omits them); refresh them on sync.

No edits.
