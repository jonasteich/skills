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
