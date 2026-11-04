# Changes to mattpocock/skills

Edits made in this fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock, see [LICENSE](LICENSE)). One entry per edit.

Format: `### <skill>: <what>` then **Why** and **Upstream tag**.

Registration (which skills load) is set in the repo's `.claude-plugin/marketplace.json`, not here; upstream files are not edited for it. `skills/LICENSE` is an added copy of upstream's `LICENSE`, so the installed plugin (rooted at `skills/`) carries it.

Vendored at `v1.3.1`.

### triage: bug briefs start with `diagnosing-bugs`

`SKILL.md` step 5 (`ready-for-agent`) and `AGENT-BRIEF.md` (template and bug example) add a `**Start with:** \`diagnosing-bugs\`` line for bugs.

**Why:** diagnosis happens inside `/implement`, not during triage (jonasteich/skills#5).
**Upstream tag:** `v1.3.1`

### prototype: UI branch takes design direction from `impeccable`

`SKILL.md` UI bullet names `impeccable` as the source of design direction; `UI.md` step 2 calls it for N structurally different directions, falls back to drafting them when it isn't installed, and keeps the throwaway, `?variant=`, switcher and capture rules.

**Why:** design questions go to the design skill (jonasteich/skills#5).
**Upstream tag:** `v1.3.1`
