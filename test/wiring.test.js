// Checks the wiring edits to upstream skills are in place (see
// plugins/engineering/CHANGES.md), so a subtree sync that drops one fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = (path) =>
  readFileSync(join(root, "plugins/engineering/skills/engineering", path), "utf8");
const changes = readFileSync(join(root, "plugins/engineering/CHANGES.md"), "utf8");

test("triage: bug briefs tell the agent to start with diagnosing-bugs", () => {
  assert.match(skill("triage/SKILL.md"), /bug.*start with `diagnosing-bugs`/i);
  const brief = skill("triage/AGENT-BRIEF.md");
  assert.match(brief, /\*\*Start with:\*\* `diagnosing-bugs`/);
  const bugExample = brief.split("### Good agent brief (bug)")[1].split("### ")[0];
  assert.match(bugExample, /\*\*Start with:\*\* `diagnosing-bugs`/);
});

test("prototype: UI branch hands design direction to impeccable", () => {
  for (const file of ["prototype/SKILL.md", "prototype/UI.md"])
    assert.match(skill(file), /`impeccable`/, file);
});

test("prototype: UI branch keeps throwaway, ?variant= and capture rules", () => {
  const ui = skill("prototype/UI.md");
  assert.match(ui, /\?variant=/);
  assert.match(ui, /throwaway branch/);
  assert.match(skill("prototype/SKILL.md"), /Throwaway from day one/);
});

test("each wiring edit is logged in CHANGES.md", () => {
  assert.match(changes, /### triage: /);
  assert.match(changes, /### prototype: /);
});
