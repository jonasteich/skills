// Checks the marketplace registers exactly the kept skills of each plugin,
// and that dropped upstream skills stay in the tree unregistered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
);
const plugin = (name) => marketplace.plugins.find((p) => p.name === name);

const KEPT_ENGINEERING = [
  "engineering/setup-matt-pocock-skills",
  "engineering/wayfinder",
  "engineering/grill-with-docs",
  "productivity/grilling",
  "engineering/domain-modeling",
  "engineering/prototype",
  "engineering/research",
  "engineering/to-spec",
  "engineering/to-tickets",
  "engineering/implement",
  "engineering/tdd",
  "engineering/code-review",
  "engineering/pr",
  "engineering/codebase-design",
  "engineering/improve-codebase-architecture",
  "engineering/triage",
  "engineering/diagnosing-bugs",
  "engineering/wizard",
  "engineering/retro",
  "productivity/writing-for-agents",
].map((s) => `./${s}`);

const DROPPED_ENGINEERING = [
  "engineering/ask-matt",
  "productivity/grill-me",
  "engineering/implement-spec",
  "productivity/teach",
  "productivity/to-questionnaire",
  "productivity/wait-what",
  "productivity/handoff",
].map((s) => `./${s}`);

test("no manifest pins a version, so installs track commits", () => {
  assert.equal(marketplace.version, undefined);
  assert.equal(marketplace.metadata?.version, undefined);
  for (const p of marketplace.plugins) assert.equal(p.version, undefined, p.name);
});

// Source is the subtree's skills/ dir, not its root: the root holds upstream's
// plugin.json, whose own skills list conflicts with a non-strict entry (load
// error) and whose version would pin installs.
test("engineering is a non-strict entry over the subtree's skills dir", () => {
  const eng = plugin("engineering");
  assert.ok(eng, "engineering plugin missing");
  assert.equal(eng.source, "./plugins/engineering/skills");
  assert.equal(eng.strict, false);
  assert.ok(!existsSync(join(root, eng.source, ".claude-plugin")), "manifest under source");
});

test("engineering registers exactly the kept skills", () => {
  assert.deepEqual([...plugin("engineering").skills].sort(), [...KEPT_ENGINEERING].sort());
});

test("every registered skill exists in the tree", () => {
  for (const p of marketplace.plugins)
    for (const s of p.skills ?? [])
      assert.ok(existsSync(join(root, p.source, s, "SKILL.md")), `${p.name}: ${s}`);
});

test("dropped skills stay in the tree but are not registered", () => {
  const eng = plugin("engineering");
  for (const s of DROPPED_ENGINEERING) {
    assert.ok(existsSync(join(root, eng.source, s, "SKILL.md")), `${s} gone from tree`);
    assert.ok(!eng.skills.includes(s), `${s} registered`);
  }
});

// A sync that brings a new upstream skill fails here until it is put on the
// kept or dropped list (in-progress/, misc/, deprecated/ are dropped wholesale).
test("every upstream engineering/productivity skill is kept or dropped", () => {
  const source = join(root, plugin("engineering").source);
  const known = new Set([...KEPT_ENGINEERING, ...DROPPED_ENGINEERING]);
  for (const group of ["engineering", "productivity"])
    for (const d of readdirSync(join(source, group), { withFileTypes: true }))
      if (d.isDirectory() && existsSync(join(source, group, d.name, "SKILL.md")))
        assert.ok(known.has(`./${group}/${d.name}`), `unlisted upstream skill ${group}/${d.name}`);
});

// source is skills/, so the installed copy only gets the license if it's there.
test("installed copy carries the upstream MIT license", () => {
  const license = readFileSync(join(root, plugin("engineering").source, "LICENSE"), "utf8");
  assert.equal(license, readFileSync(join(root, "plugins/engineering/LICENSE"), "utf8"));
});

test("upstream plugin.json is left in place with its own full list", () => {
  const upstream = JSON.parse(
    readFileSync(join(root, "plugins/engineering/.claude-plugin/plugin.json"), "utf8"),
  );
  assert.equal(upstream.name, "mattpocock-skills");
  assert.ok(upstream.skills.includes("./skills/engineering/ask-matt"));
});
