// Checks the wiring edits to upstream skills are in place and logged (see
// plugins/engineering/CHANGES.md), so a subtree sync that drops one fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (path) =>
  readFileSync(join(root, "plugins/engineering/skills/engineering", path), "utf8");
const skill = (name) => file(`${name}/SKILL.md`);
const changes = readFileSync(join(root, "plugins/engineering/CHANGES.md"), "utf8");

// The handoff rule's shared core, worded the same in every skill that hands off.
const HANDOFF_CORE =
  "Start a fresh session only when everything the next step needs is in tickets and on main";

const handsOff = (text, next) => {
  assert.ok(text.includes(HANDOFF_CORE), "handoff rule missing");
  assert.match(text, /start_session/, "desktop New-task card missing");
  assert.ok(text.includes(`run \`/clear\`, then \`${next}`), "CLI /clear instruction missing");
  assert.match(text, /[Oo]therwise ask/, "same-session fallback missing");
};

test("wayfinder hands a completed map off to /to-spec", () => {
  const text = skill("wayfinder");
  assert.match(text, /map is complete/i);
  handsOff(text, "/to-spec <map>");
});

test("to-spec reads a given map and its closed tickets as input", () => {
  const text = skill("to-spec");
  assert.match(text, /wayfinder:map/);
  assert.match(text, /closed (child )?tickets/);
});

test("grill-with-docs recommends /to-spec or /to-tickets by size", () => {
  const text = skill("grill-with-docs");
  assert.match(text, /`\/to-spec`[^\n]*more than one ticket/);
  assert.match(text, /`\/to-tickets`/);
  handsOff(text, "/to-spec");
});

test("triage: bug briefs tell the agent to start with diagnosing-bugs", () => {
  assert.match(skill("triage"), /bug.*start with `diagnosing-bugs`/i);
  const brief = file("triage/AGENT-BRIEF.md");
  assert.match(brief, /\*\*Start with:\*\* `diagnosing-bugs`/);
  const bugExample = brief.split("### Good agent brief (bug)")[1].split("### ")[0];
  assert.match(bugExample, /\*\*Start with:\*\* `diagnosing-bugs`/);
});

test("prototype: UI branch hands design direction to impeccable", () => {
  for (const path of ["prototype/SKILL.md", "prototype/UI.md"])
    assert.match(file(path), /`impeccable`/, path);
});

test("prototype: UI branch keeps throwaway, ?variant= and capture rules", () => {
  const ui = file("prototype/UI.md");
  assert.match(ui, /\?variant=/);
  assert.match(ui, /throwaway branch/);
  assert.match(skill("prototype"), /Throwaway from day one/);
});

test("each wiring edit is logged in CHANGES.md with why and upstream tag", () => {
  for (const s of ["wayfinder", "to-spec", "grill-with-docs", "triage", "prototype"]) {
    const entry = changes.split(/^### /m).find((e) => e.startsWith(`${s}:`));
    assert.ok(entry, `${s} entry missing`);
    assert.match(entry, /\*\*Why\*\*/, s);
    assert.match(entry, /\*\*Upstream tag\*\*: `v1\.3\.1`/, s);
  }
});
