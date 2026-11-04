// Runs bin/sync against throwaway upstreams and a throwaway fleet checkout:
// a sync pulls the tag, reapplies the /setup rename, and a second run is a no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = join(root, "plugins/workflow/bin/sync");

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
const write = (dir, files) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
};
const commitAll = (dir, msg) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); };
const read = (dir, path) => readFileSync(join(dir, path), "utf8");

function repo(base, name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

// A fleet checkout carrying this repo's bin/sync and a marketplace that
// registers the given engineering skills.
function fleet(base, engineeringSkills) {
  const dir = repo(base, "fleet");
  write(dir, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "skills",
      plugins: [{ name: "engineering", source: "./plugins/engineering/skills", strict: false,
        skills: engineeringSkills.map((s) => `./engineering/${s}`) }],
    }, null, 2) + "\n",
  });
  mkdirSync(join(dir, "plugins/workflow/bin"), { recursive: true });
  copyFileSync(SYNC, join(dir, "plugins/workflow/bin/sync"));
  commitAll(dir, "fleet");
  return dir;
}

const sync = (dir, args, extraEnv = {}) =>
  execFileSync(join(dir, "plugins/workflow/bin/sync"), args, {
    cwd: tmpdir(), env: { ...env, ...extraEnv }, encoding: "utf8", stdio: "pipe",
  });

const MP_V1 = {
  LICENSE: "MIT License\nCopyright (c) Matt Pocock\n",
  ".claude-plugin/plugin.json": '{ "name": "mattpocock-skills", "skills": ["./skills/engineering/setup-matt-pocock-skills"] }\n',
  "skills/engineering/setup-matt-pocock-skills/SKILL.md":
    "---\nname: setup-matt-pocock-skills\n---\n\n# Setup\n\nv1 body.\n",
  "skills/engineering/to-spec/SKILL.md":
    "If not, tell the user to run `/setup-matt-pocock-skills`.\nSee https://aihero.dev/skills-setup-matt-pocock-skills.\n",
  "skills/engineering/ask-matt/SKILL.md": "Run `/setup-matt-pocock-skills` first.\n",
};

function engineeringFixture() {
  const base = mkdtempSync(join(tmpdir(), "sync-eng-"));
  const up = repo(base, "mp");
  write(up, MP_V1);
  commitAll(up, "v1");
  git(up, "tag", "v1");
  const dir = fleet(base, ["setup-matt-pocock-skills", "to-spec"]);
  git(dir, "subtree", "add", "-q", "--prefix=plugins/engineering", up, "v1", "--squash");
  return { base, up, dir, env: { SYNC_ENGINEERING_URL: up } };
}

test("engineering sync pulls the tag and renames setup-matt-pocock-skills to setup", (t) => {
  const f = engineeringFixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  write(f.up, {
    LICENSE: "MIT License\nCopyright (c) 2026 Matt Pocock\n",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md":
      "---\nname: setup-matt-pocock-skills\n---\n\n# Setup\n\nv2 body.\n",
    "skills/engineering/setup-matt-pocock-skills/extra.md": "new in v2\n",
  });
  commitAll(f.up, "v2");
  git(f.up, "tag", "v2");

  sync(f.dir, ["engineering", "v2"], f.env);

  const skills = "plugins/engineering/skills";
  assert.equal(git(f.dir, "status", "--porcelain"), "", "sync leaves a dirty tree");
  assert.ok(!existsSync(join(f.dir, skills, "engineering/setup-matt-pocock-skills")), "old dir left");
  assert.equal(read(f.dir, `${skills}/engineering/setup/SKILL.md`), "---\nname: setup\n---\n\n# Setup\n\nv2 body.\n");
  assert.equal(read(f.dir, `${skills}/engineering/setup/extra.md`), "new in v2\n");
  assert.equal(read(f.dir, `${skills}/engineering/to-spec/SKILL.md`),
    "If not, tell the user to run `/setup`.\nSee https://aihero.dev/skills-setup-matt-pocock-skills.\n");
  assert.equal(read(f.dir, `${skills}/engineering/ask-matt/SKILL.md`), MP_V1["skills/engineering/ask-matt/SKILL.md"],
    "unregistered skill edited");
  assert.equal(read(f.dir, "plugins/engineering/.claude-plugin/plugin.json"), MP_V1[".claude-plugin/plugin.json"],
    "upstream plugin.json edited");
  assert.deepEqual(JSON.parse(read(f.dir, ".claude-plugin/marketplace.json")).plugins[0].skills,
    ["./engineering/setup", "./engineering/to-spec"]);
  assert.equal(read(f.dir, `${skills}/LICENSE`), "MIT License\nCopyright (c) 2026 Matt Pocock\n");
});

test("a second engineering sync to the same tag changes nothing", (t) => {
  const f = engineeringFixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));

  sync(f.dir, ["engineering", "v1"], f.env);
  const head = git(f.dir, "rev-parse", "HEAD");
  assert.match(read(f.dir, "plugins/engineering/skills/engineering/setup/SKILL.md"), /^---\nname: setup\n/);

  sync(f.dir, ["engineering", "v1"], f.env);
  assert.equal(git(f.dir, "rev-parse", "HEAD"), head, "second run committed");
  assert.equal(git(f.dir, "status", "--porcelain"), "", "second run left changes");
});

// The real case after the first rename: upstream keeps editing the old path.
test("a later sync lands upstream changes to the old setup dir in setup/", (t) => {
  const f = engineeringFixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  sync(f.dir, ["engineering", "v1"], f.env);
  write(f.up, {
    "skills/engineering/setup-matt-pocock-skills/SKILL.md":
      "---\nname: setup-matt-pocock-skills\n---\n\n# Setup\n\nv2 body.\n",
    "skills/engineering/setup-matt-pocock-skills/extra.md": "new in v2\n",
  });
  commitAll(f.up, "v2");
  git(f.up, "tag", "v2");

  sync(f.dir, ["engineering", "v2"], f.env);

  const setup = "plugins/engineering/skills/engineering/setup";
  assert.equal(git(f.dir, "status", "--porcelain"), "");
  assert.ok(!existsSync(join(f.dir, "plugins/engineering/skills/engineering/setup-matt-pocock-skills")));
  assert.equal(read(f.dir, `${setup}/SKILL.md`), "---\nname: setup\n---\n\n# Setup\n\nv2 body.\n");
  assert.equal(read(f.dir, `${setup}/extra.md`), "new in v2\n");
});

// design vendors only upstream's plugin/ dir, split out of a cached clone.
test("design sync vendors plugin/ at the tag with LICENSE and NOTICE, and reruns as a no-op", (t) => {
  const base = mkdtempSync(join(tmpdir(), "sync-design-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const up = repo(base, "impeccable");
  write(up, {
    LICENSE: "Apache License v1\n", "NOTICE.md": "# Third-Party Notices v1\n",
    "plugin/.claude-plugin/plugin.json": '{ "name": "impeccable", "version": "1.0.0" }\n',
    "plugin/skills/impeccable/SKILL.md": "v1\n", "cli/index.js": "not vendored\n",
  });
  commitAll(up, "v1");
  git(up, "tag", "skill-v1");
  write(up, { LICENSE: "Apache License v2\n", "plugin/skills/impeccable/SKILL.md": "v2\n" });
  commitAll(up, "v2");
  git(up, "tag", "skill-v2");
  const dir = fleet(base, []);
  const e = { SYNC_DESIGN_URL: up, SYNC_DESIGN_CACHE: join(base, "cache/impeccable") };

  sync(dir, ["design", "skill-v1"], e);
  assert.equal(read(dir, "plugins/design/skills/impeccable/SKILL.md"), "v1\n");
  assert.ok(!existsSync(join(dir, "plugins/design/cli")), "vendored outside plugin/");
  assert.ok(!existsSync(join(dir, "plugins/design/plugin")), "plugin/ not unwrapped");

  sync(dir, ["design", "skill-v2"], e);
  assert.equal(read(dir, "plugins/design/skills/impeccable/SKILL.md"), "v2\n");
  assert.equal(read(dir, "plugins/design/LICENSE"), "Apache License v2\n");
  assert.equal(read(dir, "plugins/design/NOTICE.md"), "# Third-Party Notices v1\n");
  assert.equal(git(dir, "status", "--porcelain"), "");

  const head = git(dir, "rev-parse", "HEAD");
  sync(dir, ["design", "skill-v2"], e);
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "second run committed");
  assert.equal(git(dir, "status", "--porcelain"), "", "second run left changes");
});

test("sync refuses a dirty tree", (t) => {
  const f = engineeringFixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  write(f.dir, { "stray.txt": "x" });
  git(f.dir, "add", "stray.txt");
  assert.throws(() => sync(f.dir, ["engineering", "v1"], f.env), /dirty|uncommitted/i);
});
