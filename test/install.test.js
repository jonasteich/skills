// Runs bin/install with a throwaway HOME: it links the fleet's scripts into
// ~/.local/bin, and the linked sync works on the fleet from any directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(root, "plugins/workflow/bin");

// A copy of the workflow bin dir, optionally with a stand-in runner.
function fakeBin(base, { runner }) {
  const bin = join(base, "fleet/plugins/workflow/bin");
  mkdirSync(bin, { recursive: true });
  for (const f of ["install", "sync"]) copyFileSync(join(BIN, f), join(bin, f));
  if (runner) writeFileSync(join(bin, "runner"), "#!/bin/sh\necho runner\n", { mode: 0o755 });
  return bin;
}

const install = (bin, home) =>
  execFileSync(join(bin, "install"), [], {
    cwd: tmpdir(), env: { ...process.env, HOME: home }, encoding: "utf8", stdio: "pipe",
  });

test("install links sync into ~/.local/bin, and runner once it exists", (t) => {
  const base = mkdtempSync(join(tmpdir(), "install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const bin = fakeBin(base, { runner: false });

  install(bin, home);
  const link = join(home, ".local/bin/sync");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(join(bin, "sync")));
  assert.ok(!existsSync(join(home, ".local/bin/runner")), "linked a missing runner");
  assert.ok(!existsSync(join(home, ".local/bin/install")), "linked install itself");

  writeFileSync(join(bin, "runner"), "#!/bin/sh\necho runner\n", { mode: 0o755 });
  install(bin, home);
  assert.equal(realpathSync(join(home, ".local/bin/runner")), realpathSync(join(bin, "runner")));
  assert.equal(execFileSync(join(home, ".local/bin/runner"), { encoding: "utf8" }), "runner\n");
});

test("install refuses to replace a file that isn't a link", (t) => {
  const base = mkdtempSync(join(tmpdir(), "install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const bin = fakeBin(base, { runner: false });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/sync"), "someone else's sync\n");
  assert.throws(() => install(bin, home), /not a symlink/);
});

test("linked sync works on the fleet clone from any directory", (t) => {
  const base = mkdtempSync(join(tmpdir(), "install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const bin = fakeBin(base, { runner: false });
  install(bin, home);
  // A dirty fleet clone: sync, reached through the link from another repo,
  // must check the fleet (and name it), not the directory it was called from.
  const fleet = join(base, "fleet");
  const other = join(base, "other");
  mkdirSync(other);
  for (const dir of [fleet, other]) execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: fleet });
  assert.throws(
    () => execFileSync(join(home, ".local/bin/sync"), ["engineering", "v1"], { cwd: other, encoding: "utf8", stdio: "pipe" }),
    (e) => e.status === 1 && e.stderr.includes(`uncommitted changes in ${realpathSync(fleet)}`),
  );
});
