import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeCloud, sha } from "./fixtures/cloud-sync-fake-cloud.mjs";
import { applyStaged } from "./lent-staged.mjs";

const AT = new Date(2026, 9, 27, 12).getTime();
function setup(t, write = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-lent-staged-")));
  const root = join(dir, "Notes");
  mkdirSync(root);
  writeFileSync(join(root, "plan.md"), "the plan");
  const cloud = fakeCloud();
  const trashed = [];
  const apply = (more = {}) => applyStaged({ client: cloud.client, folderId: "pc-1", folder: { id: "lent-1", path: root, name: "Notes", write }, now: () => AT,
    trashItem: async (file) => { trashed.push(readFileSync(file, "utf8")); rmSync(file); }, ...more });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, cloud, trashed, apply };
}

test("an untouched file takes the bot's version, the old one to the Recycle Bin; a new file is created", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  s.cloud.stage("pc-1", "a/b/new.md", "new");
  const outcome = await s.apply();
  assert.deepEqual(outcome, { applied: 2, kept: [], problem: null });
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "v2");
  assert.deepEqual(s.trashed, ["the plan"]);
  assert.equal(readFileSync(join(s.root, "a", "b", "new.md"), "utf8"), "new");
  assert.equal(s.cloud.lent.staged.length, 0);
});

test("a file the person changed, or removed, keeps theirs: the bot's version lands beside it", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "the bot's plan", sha("an older plan"));
  s.cloud.stage("pc-1", "gone.md", "the bot's notes", sha("what was there"));
  const outcome = await s.apply();
  assert.equal(outcome.applied, 0);
  assert.deepEqual(outcome.kept, [
    { path: "plan.md", beside: "plan (new from My Cloud, 27 Oct 2026).md", at: AT },
    { path: "gone.md", beside: "gone (new from My Cloud, 27 Oct 2026).md", at: AT },
  ]);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "the plan");
  assert.equal(readFileSync(join(s.root, "plan (new from My Cloud, 27 Oct 2026).md"), "utf8"), "the bot's plan");
  assert.equal(existsSync(join(s.root, "gone.md")), false, "a file the person removed is not brought back under its name");
  assert.equal(readFileSync(join(s.root, "gone (new from My Cloud, 27 Oct 2026).md"), "utf8"), "the bot's notes");
  assert.deepEqual(s.trashed, [], "nothing of the person's is deleted");
});

test("already there is done; a folder no longer lent with editing keeps the change waiting", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "the plan", sha("older"));
  assert.deepEqual(await s.apply(), { applied: 1, kept: [], problem: null });
  assert.deepEqual(s.trashed, []);
  const r = setup(t, false);
  r.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  assert.deepEqual(await r.apply(), { applied: 0, kept: [], problem: null });
  assert.equal(r.cloud.lent.staged.length, 1);
  assert.equal(readFileSync(join(r.root, "plan.md"), "utf8"), "the plan");
});

test("the live write's rules hold: never .git, never through a link, never a damaged download", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.dir, "outside"));
  symlinkSync(join(s.dir, "outside"), join(s.root, "link"));
  s.cloud.stage("pc-1", ".git/hooks/pre-commit", "#!/bin/sh");
  s.cloud.stage("pc-1", "link/x.md", "through a link");
  const damaged = s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  damaged.damaged = Buffer.from("not v2");
  const outcome = await s.apply();
  assert.equal(outcome.applied, 0);
  assert.match(outcome.problem, /^\.git\/hooks\/pre-commit: Files inside \.git/);
  assert.equal(existsSync(join(s.root, ".git")), false);
  assert.deepEqual(readdirSync(join(s.dir, "outside")), []);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "the plan");
  assert.deepEqual(readdirSync(s.root).sort(), ["link", "plan.md"], "no half-written file is left behind");
  assert.equal(s.cloud.lent.staged.length, 3, "none is answered, so none is lost");
  // A stopping error (signed out, offline) stops the whole pass.
  const offline = Object.assign(new Error("offline"), { name: "TimeoutError" });
  await assert.rejects(s.apply({ client: { ...s.cloud.client, stagedFile: async () => { throw offline; } }, stopper: (error) => error === offline }), /offline/);
});

test("a protected place inside a lent folder is never written", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.root, "secrets"));
  s.cloud.stage("pc-1", "secrets/key.txt", "x");
  const outcome = await s.apply({ protectedPaths: [join(s.root, "secrets")] });
  assert.match(outcome.problem, /cannot be accessed/);
  assert.deepEqual(readdirSync(join(s.root, "secrets")), []);
});

test("a replaced file keeps its own permissions, as a live write in place does", { skip: process.platform === "win32" }, async (t) => {
  const s = setup(t);
  const { chmodSync, statSync } = await import("node:fs");
  writeFileSync(join(s.root, "run.sh"), "#!/bin/sh\necho one\n");
  chmodSync(join(s.root, "run.sh"), 0o755);
  s.cloud.stage("pc-1", "run.sh", "#!/bin/sh\necho two\n", sha("#!/bin/sh\necho one\n"));
  await s.apply();
  assert.equal(readFileSync(join(s.root, "run.sh"), "utf8"), "#!/bin/sh\necho two\n");
  assert.equal(statSync(join(s.root, "run.sh")).mode & 0o777, 0o755);
});
