# Changes to mattpocock/skills

Edits made in this fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock, see [LICENSE](LICENSE)). One entry per edit.

Format: `### <skill>: <what>` then **Why** and **Upstream tag**.

Registration (which skills load) is set in the repo's `.claude-plugin/marketplace.json`, not here; upstream files are not edited for it. `skills/LICENSE` is an added copy of upstream's `LICENSE`, so the installed plugin (rooted at `skills/`) carries it.

Vendored at `v1.3.1`.

The **handoff rule** shared by the handoff edits below: start a fresh session (desktop: New-task card via `start_session`; CLI: "run `/clear`, then `/<next> …`") only when everything the next step needs is in tickets and on main; otherwise ask, and invoke the next skill in the same session on yes.

### wayfinder: hand a completed map off to `/to-spec`

Added step 6 to "Work through the map": when no open tickets remain and **Not yet specified** is empty, hand off to `/to-spec <map>` per the handoff rule.

**Why**: the planning skills didn't hand off to each other; the next step had to be remembered (spec #1, story 1).

**Upstream tag**: `v1.3.1`

### to-spec: read a given map and its closed tickets as input

Added one paragraph: when invoked with a `wayfinder:map` issue, read the map and its closed child tickets (with resolution comments) alongside the conversation.

**Why**: a spec from a map must reflect every decision on it, not just the current chat (spec #1, story 2).

**Upstream tag**: `v1.3.1`

### grill-with-docs: recommend `/to-spec` or `/to-tickets` at the end

Added a closing paragraph: recommend `/to-spec` (more than one ticket) or `/to-tickets` (small), then hand off per the handoff rule.

**Why**: ceremony should match size, and the next step shouldn't have to be remembered (spec #1, stories 3-4).

**Upstream tag**: `v1.3.1`

### triage: bug briefs start with `diagnosing-bugs`

`SKILL.md` step 5 (`ready-for-agent`) and `AGENT-BRIEF.md` (template and bug example) add a `**Start with:** \`diagnosing-bugs\`` line for bugs.

**Why**: diagnosis happens inside `/implement`, not during triage (jonasteich/skills#5).

**Upstream tag**: `v1.3.1`

### prototype: UI branch takes design direction from `impeccable`

`SKILL.md` UI bullet names `impeccable` as the source of design direction; `UI.md` step 2 calls it for N structurally different directions, falls back to drafting them when it isn't installed, and keeps the throwaway, `?variant=`, switcher and capture rules.

**Why**: design questions go to the design skill (jonasteich/skills#5).

**Upstream tag**: `v1.3.1`

### setup: renamed from `setup-matt-pocock-skills` to `/setup`

Skill dir moved to `skills/engineering/setup/`, frontmatter `name: setup`, and every `/setup-matt-pocock-skills` reference in the registered skills (code-review, to-spec, to-tickets, triage, wayfinder) now reads `/setup`. Applied by `plugins/workflow/bin/sync` after each pull, so it's reapplied on every sync and a rerun changes nothing; upstream docs, `plugin.json` and dropped skills keep the old name.

**Why**: the setup skill is clearly mine (spec #1, story 7; jonasteich/skills#3).

**Upstream tag**: `v1.3.1`
