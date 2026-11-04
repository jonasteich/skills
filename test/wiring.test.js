// Checks the planning-chain wiring edits (spec #1, "Skill edits" / "Handoff rule")
// are present in the installed skill text and logged in CHANGES.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = (name) =>
  readFileSync(join(root, "plugins/engineering/skills/engineering", name, "SKILL.md"), "utf8");
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

test("each wiring edit is logged in CHANGES.md with why and upstream tag", () => {
  for (const s of ["wayfinder", "to-spec", "grill-with-docs"]) {
    const entry = changes.split(/^### /m).find((e) => e.startsWith(`${s}:`));
    assert.ok(entry, `${s} entry missing`);
    assert.match(entry, /\*\*Why\*\*/, s);
    assert.match(entry, /\*\*Upstream tag\*\*: `v1\.3\.1`/, s);
  }
});
