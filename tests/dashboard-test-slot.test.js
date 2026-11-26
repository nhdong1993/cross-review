// The machine's test queue on the dashboard (lib/dashboard/test-slot.js): saved defaults with the same contract as
// agent-rules bin/test-slot, the records it reads, the running step, the Testing save, and what the HTTP API shows.
// Real processes (ps, KERN_PROCARGS2, /proc) only on macOS and Linux; everything else runs on injected rows.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lockHolder, parseTestSlotConf, psRows, readStep, readTestRuns, readTestSlotConf, saveTestSlotKey, selectStep, stepCandidates, testSlotPaths, TEST_SLOT_DEFAULTS } from "../skill-packs/cross-review/scripts/lib/dashboard/test-slot.js";
import { startDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";
import { saveBanner } from "../skill-packs/cross-review/scripts/lib/dashboard/ui/settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, "../skill-packs/cross-review/scripts/lib/dashboard/test-slot.js");
const PROCARGS = path.join(HERE, "../skill-packs/cross-review/scripts/lib/dashboard/procargs.py");
const STEPS = JSON.parse(fs.readFileSync(path.join(HERE, "helpers/fixtures/test-slot-steps.json"), "utf8"));
const REAL_PS = process.platform === "darwin" || process.platform === "linux";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tmp;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-slot-")));
  process.env.HOME = path.join(tmp, "home");
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A test-slot install as the agent-rules README sets it up: lock, private record dir. */
function provider({ dir = true, lock = true } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "agents-"));
  const p = testSlotPaths({ CROSS_REVIEW_AGENTS_DIR: root });
  fs.mkdirSync(path.dirname(p.lock), { recursive: true });
  if (lock) fs.writeFileSync(p.lock, "");
  if (dir) fs.mkdirSync(p.dir, { mode: 0o700 });
  return p;
}
const record = (p, r) => fs.writeFileSync(path.join(p.dir, `${r.pid}.json`), JSON.stringify({ v: 1, label: "custom", repo: "", worktree: "w", ...r }));
const pstartOf = pid => spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).stdout.trim().replace(/\s+/g, " ");

// ---- saved defaults: same table as agent-rules bin/test-slot-selftest (conf_case) ----
const CONF = [
  ["empty", "", 2, false],
  ["jobs 4", "TEST_SLOT_JOBS=4\n", 4, false],
  ["jobs 0", "TEST_SLOT_JOBS=0\n", 2, true],
  ["leading zeros", "TEST_SLOT_JOBS=004\n", 4, false],
  ["18 chars, 1 digit", "TEST_SLOT_JOBS=000000000000000001\n", 1, false],
  ["16 digits", "TEST_SLOT_JOBS=1234567890123456\n", 2, true],
  ["not a number", "TEST_SLOT_JOBS=4SENTINEL\n", 2, true],
  ["empty value", "TEST_SLOT_JOBS=\n", 2, true],
  ["last duplicate wins", "TEST_SLOT_JOBS=3\nTEST_SLOT_JOBS=5\n", 5, false],
  ["last duplicate invalid", "TEST_SLOT_JOBS=3\nTEST_SLOT_JOBS=0\n", 2, true],
  ["garbage line", "SENTINEL garbage\nTEST_SLOT_JOBS=3\n", 3, true],
  ["unknown key", "TEST_SLOT_FOO=SENTINEL\n", 2, true],
  ["blank and comment", "\n# note\nTEST_SLOT_JOBS=3\n", 3, false],
  ["CRLF", "TEST_SLOT_JOBS=3\r\n", 3, false],
  ["no final newline", "TEST_SLOT_JOBS=3", 3, false],
  ["wait 0", "TEST_SLOT_WAIT=0\n", 2, false],
  ["wait at ceiling", "TEST_SLOT_WAIT=4294967295\n", 2, false],
  ["wait above ceiling", "TEST_SLOT_WAIT=4294967296\n", 2, true],
  ["grace 0", "TEST_SLOT_KILL_GRACE=0\n", 2, false],
  ["grace not a number", "TEST_SLOT_KILL_GRACE=-1\n", 2, true],
  ["CR inside the last value", "TEST_SLOT_JOBS=3\nTEST_SLOT_JOBS=5\r6\n", 2, true],
  ["U+2028 inside the last value", "TEST_SLOT_JOBS=3\nTEST_SLOT_JOBS=5\u20286\n", 2, true],
  ["NUL inside the last value", "TEST_SLOT_JOBS=3\nTEST_SLOT_JOBS=5\u00006\n", 2, true],
  ["NUL in another key", "TEST_SLOT_JOBS=4\nTEST_SLOT_WAIT=1\u00002\n", 4, true],
];

test("saved defaults follow test-slot's contract", () => {
  for (const [name, text, jobs, warn] of CONF) {
    const { saved, invalid } = parseTestSlotConf(text);
    assert.equal(saved.TEST_SLOT_JOBS ?? 2, jobs, name);
    assert.equal(invalid, warn, name);
  }
  assert.deepEqual(parseTestSlotConf("TEST_SLOT_WAIT=0\nTEST_SLOT_KILL_GRACE=007\n").saved, { TEST_SLOT_WAIT: 0, TEST_SLOT_KILL_GRACE: 7 });
  assert.equal(parseTestSlotConf("TEST_SLOT_WAIT=4294967295\n").saved.TEST_SLOT_WAIT, 4294967295);
  const p = provider();
  assert.deepEqual(readTestSlotConf(p), { available: true, values: TEST_SLOT_DEFAULTS, saved: {}, invalid: false });
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=4\nTEST_SLOT_WAIT=x\n");
  assert.deepEqual(readTestSlotConf(p).values, { ...TEST_SLOT_DEFAULTS, TEST_SLOT_JOBS: 4 });
  assert.equal(readTestSlotConf(p).invalid, true);
});

// ---- availability: hidden, empty, unreadable ----

test("no provider: hidden, and nothing is spawned (the path Windows takes)", () => {
  const calls = [];
  const spy = () => (calls.push(1), []);
  for (const p of [provider({ dir: false }), provider({ lock: false })]) {
    assert.deepEqual(readTestRuns({ paths: p, processRows: spy, step: spy }), { available: false });
    assert.deepEqual(readTestSlotConf(p), { available: false });
  }
  assert.equal(calls.length, 0);
});

test("installed and idle: empty list without a ps call; unreadable dir and failed ps are errors", () => {
  const p = provider();
  let ps = 0;
  assert.deepEqual(readTestRuns({ paths: p, processRows: () => (ps++, []) }), { available: true, runs: [] });
  assert.equal(ps, 0, "no record, no ps");
  record(p, { pid: 10, pstart: "x", state: "waiting", queued_at: 1 });
  assert.deepEqual(readTestRuns({ paths: p, processRows: () => null }), { available: true, error: true, runs: [] });
  if (process.platform !== "win32" && process.getuid() !== 0) {
    fs.chmodSync(p.dir, 0o000);
    try {
      assert.equal(readTestRuns({ paths: p, processRows: () => [] }).error, true);
    } finally {
      fs.chmodSync(p.dir, 0o700);
    }
    // an unreadable record, or a run folder that cannot be looked into, is unreadable, never idle or absent
    const one = path.join(p.dir, "10.json");
    fs.chmodSync(one, 0o000);
    try {
      assert.deepEqual(readTestRuns({ paths: p, processRows: () => [{ pid: 10, ppid: 1, lstart: "x" }] }), { available: true, error: true, runs: [] });
    } finally {
      fs.chmodSync(one, 0o600);
    }
    const run = path.dirname(p.dir);
    fs.chmodSync(run, 0o000);
    try {
      assert.deepEqual(readTestRuns({ paths: p, processRows: () => [] }), { available: true, error: true, runs: [] });
      assert.deepEqual(readTestSlotConf(p), { available: true, error: true });
      return assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 4, p), e => e.status === 409);
    } finally {
      fs.chmodSync(run, 0o700);
    }
  }
});

test("a config path that cannot be read is an error, not the defaults", () => {
  const p = provider();
  fs.mkdirSync(p.conf);
  assert.deepEqual(readTestSlotConf(p), { available: true, error: true });
});

// ---- records ----

test("runs: running first, waiters by queue time; dead, reused and malformed records skipped, never deleted", () => {
  const p = provider();
  record(p, { pid: 100, pstart: "Wed Nov 25 10:00:00 2026", state: "running", queued_at: 30, running_at: 35, payload: 101, label: "cargo test", repo: "app", worktree: "feature" });
  record(p, { pid: 200, pstart: "Wed Nov 25 10:00:01 2026", state: "waiting", queued_at: 50 });
  record(p, { pid: 300, pstart: "Wed Nov 25 10:00:02 2026", state: "waiting", queued_at: 40 });
  record(p, { pid: 400, pstart: "Wed Nov 25 10:00:03 2026", state: "waiting", queued_at: 1 }); // no such process
  record(p, { pid: 500, pstart: "Wed Nov 25 09:00:00 2026", state: "waiting", queued_at: 1 }); // pid reused
  record(p, { pid: 600, pstart: "x", state: "sleeping", queued_at: 1 });
  record(p, { pid: 700, pstart: "x", state: "running", queued_at: 1 }); // running without running_at
  fs.writeFileSync(path.join(p.dir, "800.json"), "{half");
  fs.writeFileSync(path.join(p.dir, "900.json"), JSON.stringify({ v: 1, pid: 901, pstart: "x", state: "waiting", queued_at: 1 }));
  const rows = [
    { pid: 100, ppid: 1, lstart: "Wed Nov 25 10:00:00 2026" },
    { pid: 200, ppid: 1, lstart: "Wed Nov 25 10:00:01 2026" },
    { pid: 300, ppid: 1, lstart: "Wed Nov 25 10:00:02 2026" },
    { pid: 500, ppid: 1, lstart: "Wed Nov 25 10:00:09 2026" },
    { pid: 600, ppid: 1, lstart: "x" }, { pid: 700, ppid: 1, lstart: "x" }, { pid: 901, ppid: 1, lstart: "x" },
  ];
  const before = fs.readdirSync(p.dir).sort();
  const out = readTestRuns({ paths: p, processRows: () => rows, step: () => null });
  assert.deepEqual(out.runs.map(r => r.pid), [100, 300, 200]);
  assert.deepEqual(out.runs[0], { pid: 100, state: "running", label: "cargo test", repo: "app", worktree: "feature", queuedAt: 30, runningAt: 35, step: null });
  assert.equal(out.runs[1].runningAt, null);
  assert.ok(!("dir" in out.runs[0]), "the full directory path is not published");
  assert.deepEqual(fs.readdirSync(p.dir).sort(), before);
});

test("step: one readStep call per snapshot with the payload tree deepest first; none for waiters", () => {
  const p = provider();
  record(p, { pid: 100, pstart: "A", state: "running", queued_at: 1, running_at: 2, payload: 101 });
  record(p, { pid: 200, pstart: "B", state: "waiting", queued_at: 3 });
  // wrapper 100 → payload 101 (bash) → 102, 104; 102 → 103
  const rows = [
    { pid: 100, ppid: 1, lstart: "A" }, { pid: 200, ppid: 1, lstart: "B" },
    { pid: 101, ppid: 100, lstart: "x" }, { pid: 102, ppid: 101, lstart: "x" }, { pid: 104, ppid: 101, lstart: "x" }, { pid: 103, ppid: 102, lstart: "x" },
  ];
  const calls = [];
  const out = readTestRuns({ paths: p, processRows: () => rows, step: pids => (calls.push(pids), { program: "node", script: "./stage.mjs" }) });
  assert.deepEqual(calls, [[103, 104, 102, 101]]);
  assert.deepEqual(out.runs[0].step, { program: "node", script: "./stage.mjs" });
  assert.equal(out.runs[1].step, null);
  // the reversed ancestry gives the reversed order, so the deepest script wins either way
  assert.deepEqual(stepCandidates([{ pid: 1, ppid: 100 }, { pid: 3, ppid: 1 }, { pid: 2, ppid: 3 }], 100, 1), [2, 3, 1]);
  assert.deepEqual(stepCandidates([{ pid: 1, ppid: 100 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }], 100, 1), [3, 2, 1]);
  assert.deepEqual(stepCandidates([], 100, 1), []);
  // only the payload the record names: not the wrapper's helpers (a status write, EXIT cleanup), not a gone payload
  assert.deepEqual(stepCandidates([{ pid: 7, ppid: 100 }], 100, 101), [], "payload gone, a helper left");
  assert.deepEqual(stepCandidates([{ pid: 101, ppid: 5 }], 100, 101), [], "pid reused elsewhere");
  assert.deepEqual(stepCandidates([{ pid: 7, ppid: 100 }], 100, undefined), [], "no payload named yet");
  // candidates are read only until the first script
  const seen = [];
  const lazy = new Proxy(STEPS[0].entries, { get: (t, k) => (/^\d+$/.test(k) && seen.push(k), t[k]) });
  selectStep(lazy);
  assert.deepEqual(seen, ["0", "1"], "the sleep, then the script; the shell under it is never read");
  fs.rmSync(path.join(p.dir, "100.json"));
  calls.length = 0;
  readTestRuns({ paths: p, processRows: () => rows, step: pids => (calls.push(pids), null) });
  assert.equal(calls.length, 0, "waiters only: no argument reads");
});

test("step selection: the shared table, in JS and in procargs.py", () => {
  for (const c of STEPS) assert.deepEqual(selectStep(c.entries), c.want, c.name);
  if (!REAL_PS) return;
  for (const c of STEPS) {
    const r = spawnSync("python3", ["-I", PROCARGS, "--select"], { input: JSON.stringify(c.entries), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), c.want, `procargs.py: ${c.name}`);
  }
});

// ---- real processes ----

/** A stand-in for the wrapper: bash → payload bash → node <script> SENTINEL_ARG (sleeping), as test-slot spawns it. */
async function liveRun(script) {
  const dir = fs.mkdtempSync(path.join(tmp, "live-"));
  fs.writeFileSync(path.join(dir, script), "setTimeout(() => {}, 60000);\n");
  const child = spawn("/bin/bash", ["-c", `bash -c 'node "$1" SENTINEL_ARG; true' _ "$0" & wait`, `./${script}`], { cwd: dir, stdio: "ignore", detached: true });
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }; // its own group: the whole tree
  try {
    const until = Date.now() + 5000;
    for (;;) {
      const rows = psRows();
      if (!rows) throw new Error("ps failed while starting the live run");
      const payload = rows.find(r => r.ppid === child.pid);
      if (payload && rows.some(r => r.ppid === payload.pid)) return { pid: child.pid, payload: payload.pid, stop };
      if (Date.now() > until) throw new Error("live run did not start");
      await sleep(50);
    }
  } catch (e) {
    stop(); // this helper owns the group until it hands it over
    throw e;
  }
}

test("real processes: the step is the script, never its arguments; a query-shaped name shows the program only", { skip: !REAL_PS }, async () => {
  for (const [script, want] of [["stage with space.mjs", { program: "node", script: "./stage with space.mjs" }], ["stage.mjs?token=SENTINEL.mjs", { program: "node" }]]) {
    const run = await liveRun(script);
    try {
      const p = provider();
      record(p, { pid: run.pid, pstart: pstartOf(run.pid), state: "running", queued_at: 1, running_at: 2, payload: run.payload });
      let calls = 0;
      const out = readTestRuns({ paths: p, step: pids => (calls++, readStep(pids)) });
      assert.equal(calls, 1);
      assert.equal(out.runs.length, 1, JSON.stringify(out));
      const step = { ...out.runs[0].step };
      if (/^node/.test(step.program)) step.program = "node"; // a versioned binary name on some installs
      assert.deepEqual(step, want);
      assert.ok(!JSON.stringify(out).includes("SENTINEL"), JSON.stringify(out));
    } finally {
      run.stop();
    }
  }
});

// ---- Testing save ----

test("save: one key into the file as it is now, other lines kept, private, no temp left", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "# mine\nTEST_SLOT_WAIT=100\nTEST_SLOT_JOBS=3\nOTHER=1\nTEST_SLOT_JOBS=9\n");
  const r = await saveTestSlotKey("TEST_SLOT_JOBS", "04", p);
  assert.equal(fs.readFileSync(p.conf, "utf8"), "# mine\nTEST_SLOT_WAIT=100\nTEST_SLOT_JOBS=4\nOTHER=1\n");
  assert.equal(r.values.TEST_SLOT_JOBS, 4);
  if (process.platform !== "win32") assert.equal(fs.statSync(p.conf).mode & 0o777, 0o600);
  await saveTestSlotKey("TEST_SLOT_KILL_GRACE", 0, p);
  assert.match(fs.readFileSync(p.conf, "utf8"), /\nTEST_SLOT_KILL_GRACE=0\n$/);
  assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).filter(n => n.includes(".tmp") || n.endsWith(".lock")), []);
  for (const [k, v] of [["TEST_SLOT_JOBS", 0], ["TEST_SLOT_JOBS", "2; rm"], ["TEST_SLOT_WAIT", 4294967296], ["TEST_SLOT_FOO", 1], ["TEST_SLOT_JOBS", "\n"],
    ["TEST_SLOT_JOBS", [4]], ["TEST_SLOT_JOBS", { 0: 4 }], ["TEST_SLOT_JOBS", true], ["TEST_SLOT_JOBS", null], ["TEST_SLOT_JOBS", 4.5], ["TEST_SLOT_WAIT", -1]]) {
    await assert.rejects(saveTestSlotKey(k, v, p), e => e.status === 400, `${k}=${v}`);
  }
  await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 2, provider({ dir: false })), e => e.status === 409);
});

test("save: a write that fails leaves no temporary file and no lock", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\n");
  for (const failing of [1, 2]) { // the lock's file, then the new config
    let calls = 0;
    const real = fs.writeFileSync;
    const m = mock.method(fs, "writeFileSync", (...args) => {
      if (++calls === failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return real(...args);
    });
    try {
      await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 4, p), e => e.code === "ENOSPC");
    } finally {
      m.mock.restore();
    }
    assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).sort(), ["run", "test-slot.conf"], `write ${failing}`);
    assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=2\n");
  }
});

test("save: a temp file that cannot be removed never keeps the lock", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\n");
  const real = fs.unlinkSync;
  let once = true;
  const m = mock.method(fs, "unlinkSync", f => {
    if (once && String(f).endsWith(".tmp")) {
      once = false;
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    }
    return real(f);
  });
  try {
    await saveTestSlotKey("TEST_SLOT_JOBS", 4, p);
  } finally {
    m.mock.restore();
  }
  assert.equal(fs.existsSync(`${p.conf}.lock`), false, "lock released");
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=4\n");
  assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).sort(), ["run", "test-slot.conf"], "the temp was removed on a retry");
  // a temp that never goes away: the save that worked says so with a warning, after the lock is released
  const stuck = mock.method(fs, "unlinkSync", f => {
    if (String(f).endsWith(".tmp")) throw Object.assign(new Error("i/o error"), { code: "EIO" });
    return real(f);
  });
  try {
    const r = await saveTestSlotKey("TEST_SLOT_JOBS", 5, p);
    assert.equal(r.values.TEST_SLOT_JOBS, 5);
    assert.match(r.warning, /^Saved\. .*\.tmp could not be removed: delete it by hand\.$/);
    // and a save that failed keeps its own error, never "saved"
    const full = mock.method(fs, "renameSync", () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); });
    try {
      // the rename's own error stays first; both temps it could not remove are named
      await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 9, p), e => /^ENOSPC writing .*\. Not saved, and .*\.tmp and .*\.tmp could not be removed: delete it by hand\.$/.test(e.message));
    } finally {
      full.mock.restore();
    }
  } finally {
    stuck.mock.restore();
  }
  assert.equal(fs.existsSync(`${p.conf}.lock`), false);
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=5\n");
  for (const n of fs.readdirSync(path.dirname(p.conf))) if (n.endsWith(".tmp")) fs.rmSync(path.join(path.dirname(p.conf), n));
});

test("save: every kept line keeps its own ending, also when the duplicate after it goes", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=4\n# keep\r\nTEST_SLOT_JOBS=6");
  await saveTestSlotKey("TEST_SLOT_JOBS", 7, p);
  assert.equal(fs.readFileSync(p.conf, "latin1"), "TEST_SLOT_JOBS=7\n# keep\r\n");
  fs.writeFileSync(p.conf, "# a\r\nTEST_SLOT_WAIT=5\r\n# b\n");
  await saveTestSlotKey("TEST_SLOT_WAIT", 6, p);
  assert.equal(fs.readFileSync(p.conf, "latin1"), "# a\r\nTEST_SLOT_WAIT=6\r\n# b\n");
});

test("save: a lock that cannot be released after the save still reports the saved value", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\n");
  const real = fs.unlinkSync;
  const m = mock.method(fs, "unlinkSync", f => {
    if (String(f).endsWith(".lock")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return real(f);
  });
  let r;
  try {
    r = await saveTestSlotKey("TEST_SLOT_JOBS", 8, p);
  } finally {
    m.mock.restore();
  }
  assert.equal(r.values.TEST_SLOT_JOBS, 8);
  assert.match(r.warning, /^Saved\. .*test-slot\.conf\.lock \(stop every dashboard first\) could not be removed: delete it by hand\.$/);
  fs.rmSync(`${p.conf}.lock`);
});

test("save: a failed save whose lock is stuck says how to clear it", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const real = fs.unlinkSync;
  const ro = () => { throw Object.assign(new Error("read-only file system"), { code: "EROFS" }); };
  const rename = mock.method(fs, "renameSync", ro);
  const unlink = mock.method(fs, "unlinkSync", f => (String(f).endsWith(".lock") ? ro() : real(f)));
  try {
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 8, p), e => e.status === 500 &&
      /^EROFS writing .*test-slot\.conf\. Not saved, and .*test-slot\.conf\.lock \(stop every dashboard first\) could not be removed: delete it by hand\.$/.test(e.message));
  } finally {
    rename.mock.restore();
    unlink.mock.restore();
  }
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=6\n");
  fs.rmSync(`${p.conf}.lock`);
});

test("save: a failed rename whose config temp cannot be removed names it", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const real = fs.unlinkSync;
  const ro = () => { throw Object.assign(new Error("read-only file system"), { code: "EROFS" }); };
  const rename = mock.method(fs, "renameSync", ro);
  const unlink = mock.method(fs, "unlinkSync", f => (/test-slot\.conf\.\d+\.[0-9a-f-]+\.tmp$/.test(String(f)) ? ro() : real(f)));
  try {
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 8, p), e => /^EROFS writing .*\. Not saved, and .*test-slot\.conf\.\d+\.[0-9a-f-]+\.tmp could not be removed: delete it by hand\.$/.test(e.message));
  } finally {
    rename.mock.restore();
    unlink.mock.restore();
  }
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=6\n");
  assert.equal(fs.existsSync(`${p.conf}.lock`), false);
  for (const n of fs.readdirSync(path.dirname(p.conf))) if (n.endsWith(".tmp")) fs.rmSync(path.join(path.dirname(p.conf), n));
});

test("save: the saved values come from what was written, even if the file cannot be read back", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const real = fs.readFileSync;
  let reads = 0;
  const m = mock.method(fs, "readFileSync", (f, ...rest) => {
    if (f === p.conf && ++reads > 1) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return real(f, ...rest);
  });
  let r;
  try {
    r = await saveTestSlotKey("TEST_SLOT_JOBS", 8, p);
  } finally {
    m.mock.restore();
  }
  assert.equal(r.values.TEST_SLOT_JOBS, 8);
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=8\n");
});

test("save: a file already at the temp path is never touched", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const sentinel = `${p.conf}.${process.pid}.fixed.tmp`;
  fs.writeFileSync(sentinel, "not ours");
  const m = mock.method(crypto, "randomUUID", () => "fixed");
  try {
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 8, p), e => e.code === "EEXIST");
  } finally {
    m.mock.restore();
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "not ours");
  assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).sort(), ["run", "test-slot.conf", path.basename(sentinel)].sort());
  fs.rmSync(sentinel);
});

test("save: a write that fails keeps its error when its temp will not go either", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const realWrite = fs.writeFileSync;
  const realUnlink = fs.unlinkSync;
  let writes = 0;
  const w = mock.method(fs, "writeFileSync", (...a) => {
    if (++writes === 2) throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); // the new config
    return realWrite(...a);
  });
  const u = mock.method(fs, "unlinkSync", f => {
    if (/test-slot\.conf\.\d+\.[0-9a-f-]+\.tmp$/.test(String(f))) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return realUnlink(f);
  });
  try {
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 8, p), e => /^ENOSPC writing .*\. Not saved, and .*test-slot\.conf\.\d+\.[0-9a-f-]+\.tmp could not be removed: delete it by hand\.$/.test(e.message));
  } finally {
    w.mock.restore();
    u.mock.restore();
  }
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=6\n");
  assert.equal(fs.existsSync(`${p.conf}.lock`), false);
  for (const n of fs.readdirSync(path.dirname(p.conf))) if (n.endsWith(".tmp")) fs.rmSync(path.join(path.dirname(p.conf), n));
});

test("save: a write that fails and then fails to close keeps the write's error", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=6\n");
  const realWrite = fs.writeFileSync;
  const realClose = fs.closeSync;
  let writes = 0;
  let failedFd = null;
  const w = mock.method(fs, "writeFileSync", (...a) => {
    if (++writes === 2) {
      failedFd = a[0]; // the new config's descriptor
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    }
    return realWrite(...a);
  });
  const c = mock.method(fs, "closeSync", fd => {
    realClose(fd);
    if (fd === failedFd) throw Object.assign(new Error("i/o error"), { code: "EIO" });
  });
  try {
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 8, p), e => e.code === "ENOSPC");
  } finally {
    w.mock.restore();
    c.mock.restore();
  }
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=6\n");
  assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).sort(), ["run", "test-slot.conf"]);
});

test("save banner: failures and cleanup notices are all shown, none hides another", () => {
  assert.deepEqual(saveBanner([], []), { state: "saved", text: "" });
  assert.deepEqual(saveBanner([], ["Saved. a.tmp could not be removed: delete it by hand.", "Saved. b.tmp could not be removed: delete it by hand."]),
    { state: "warn", text: "Saved. a.tmp could not be removed: delete it by hand. Saved. b.tmp could not be removed: delete it by hand." });
  assert.deepEqual(saveBanner(["Another dashboard is saving the Testing settings. Try again."], ["Saved. x.lock (stop every dashboard first) could not be removed: delete it by hand."]),
    { state: "failed", text: "Another dashboard is saving the Testing settings. Try again. Saved. x.lock (stop every dashboard first) could not be removed: delete it by hand." });
  assert.equal(saveBanner(["same", "same"], []).text, "same");
});

test("save: an unterminated last line stays unterminated", async () => {
  const p = provider();
  fs.writeFileSync(p.conf, Buffer.from("TEST_SLOT_JOBS=4\n# caf\xe9", "latin1"));
  await saveTestSlotKey("TEST_SLOT_JOBS", 7, p);
  assert.deepEqual(fs.readFileSync(p.conf), Buffer.from("TEST_SLOT_JOBS=7\n# caf\xe9", "latin1"));
  await saveTestSlotKey("TEST_SLOT_WAIT", 20, p); // a new key needs a break before it, and nothing after
  assert.deepEqual(fs.readFileSync(p.conf), Buffer.from("TEST_SLOT_JOBS=7\n# caf\xe9\nTEST_SLOT_WAIT=20", "latin1"));
});

test("save: lines it does not edit stay byte for byte, whatever their encoding", async () => {
  const p = provider();
  const head = Buffer.concat([Buffer.from("# caf\xe9 (Latin-1)\n", "latin1"), Buffer.from("TEST_SLOT_JOBS=4\n# \u00e9 UTF-8\n", "utf8")]);
  fs.writeFileSync(p.conf, Buffer.concat([head, Buffer.from("TEST_SLOT_WAIT=100\n")]));
  const r = await saveTestSlotKey("TEST_SLOT_WAIT", 20, p);
  assert.equal(r.values.TEST_SLOT_JOBS, 4);
  assert.deepEqual(fs.readFileSync(p.conf), Buffer.concat([head, Buffer.from("TEST_SLOT_WAIT=20\n")]));
});

test("save: a save that waited while test-slot was switched off writes nothing", { skip: !REAL_PS }, async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\n");
  const lock = `${p.conf}.lock`;
  fs.writeFileSync(lock, `${process.pid} ${pstartOf(process.pid)}\n`); // another live writer holds it
  const saving = saveTestSlotKey("TEST_SLOT_JOBS", 7, p);
  await sleep(200);
  fs.rmSync(p.dir, { recursive: true });
  fs.rmSync(lock);
  await assert.rejects(saving, e => e.status === 409);
  assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=2\n");
  assert.equal(fs.existsSync(lock), false);
});

test("save: a lock whose owner cannot be checked is never called abandoned", () => {
  const p = provider();
  const lock = `${p.conf}.lock`;
  fs.writeFileSync(lock, `${process.pid} Wed Nov 25 10:00:00 2026\n`);
  assert.match(lockHolder(lock, () => ""), /could not be checked\. Stop every dashboard, then delete/);
  assert.match(lockHolder(lock, () => "Wed Nov 25 10:00:00 2026"), /Another dashboard is saving/);
  assert.match(lockHolder(lock, () => "Thu Nov 26 10:00:00 2026"), /left .* behind/, "pid reused: the owner is gone");
  fs.writeFileSync(lock, `${process.pid} Mon Nov  2 12:34:56 2026\n`);
  assert.match(lockHolder(lock, () => "Mon Nov 2 12:34:56 2026"), /Another dashboard is saving/, "same time, other spacing");
  fs.writeFileSync(lock, `${process.pid} Mon Nov 02 12:34:56 2026\n`);
  assert.match(lockHolder(lock, () => "Mon Nov 2 12:34:56 2026"), /Another dashboard is saving/, "same instant, zero-padded day");
  fs.writeFileSync(lock, `${process.pid} Tue Feb 31 12:34:56 2026\n`);
  assert.match(lockHolder(lock, () => "Wed Nov 25 10:00:00 2026"), /names no owner that can be checked/, "a day that does not exist proves nothing");
  fs.writeFileSync(lock, "9999999999999999999999 Thu Feb 29 12:34:56 2024\n");
  assert.match(lockHolder(lock, () => ""), /names no owner that can be checked/, "a pid no process can have proves nothing");
  fs.writeFileSync(lock, `${process.pid} Qqq Bbb 88 99:99:99 2026\n`);
  assert.match(lockHolder(lock, () => "Wed Nov 25 10:00:00 2026"), /names no owner that can be checked/, "an impossible date proves nothing");
  fs.writeFileSync(lock, `${process.pid} nonsense\n`);
  assert.match(lockHolder(lock, () => "Wed Nov 25 10:00:00 2026"), /names no owner that can be checked\. Stop every dashboard/, "a malformed start time proves nothing");
});

test("save: two dashboard processes saving at once both keep their key", { skip: process.platform === "win32" }, async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\nTEST_SLOT_WAIT=100\n");
  const one = (k, v) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", `import { saveTestSlotKey, testSlotPaths } from ${JSON.stringify(new URL(`file://${MODULE}`).href)};
for (let i = 0; i < 20; i++) await saveTestSlotKey(${JSON.stringify(k)}, ${v} + (i % 2), testSlotPaths({ CROSS_REVIEW_AGENTS_DIR: ${JSON.stringify(path.dirname(p.conf))} }));
await saveTestSlotKey(${JSON.stringify(k)}, ${v}, testSlotPaths({ CROSS_REVIEW_AGENTS_DIR: ${JSON.stringify(path.dirname(p.conf))} }));`], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", d => { err += d; });
    c.on("exit", code => (code === 0 ? resolve() : reject(new Error(err))));
  });
  await Promise.all([one("TEST_SLOT_JOBS", 4), one("TEST_SLOT_WAIT", 20)]);
  assert.deepEqual(parseTestSlotConf(fs.readFileSync(p.conf, "utf8")).saved, { TEST_SLOT_JOBS: 4, TEST_SLOT_WAIT: 20 });
});

test("save: a held lock is never taken; live, dead and ownerless holders each say what to do", { skip: !REAL_PS }, async () => {
  const p = provider();
  fs.writeFileSync(p.conf, "TEST_SLOT_JOBS=2\n");
  const lock = `${p.conf}.lock`;
  const cases = [
    [`${process.pid} ${pstartOf(process.pid)}\n`, /Another dashboard is saving/],
    [`999999 Wed Nov 25 10:00:00 2026\n`, /left .* behind\. Delete that file/],
    ["", /names no owner that can be checked\. Stop every dashboard, then delete .*test-slot\.conf\.lock and try again/],
  ];
  for (const [content, msg] of cases) {
    fs.writeFileSync(lock, content);
    const t = Date.now();
    await assert.rejects(saveTestSlotKey("TEST_SLOT_JOBS", 4, p), e => e.status === 409 && msg.test(e.message) && e.message.includes(content ? "" : lock));
    assert.ok(Date.now() - t >= 1900, "waited for the holder first");
    assert.equal(fs.readFileSync(lock, "utf8"), content, "lock untouched");
    assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=2\n", "config untouched");
  }
  fs.rmSync(lock);
  assert.deepEqual(fs.readdirSync(path.dirname(p.conf)).filter(n => n.includes(".tmp")), []);
});

// ---- HTTP ----

function request(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", d => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}
/** The first list-stream event, as the page receives it. */
function firstListEvent(d) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: d.port, path: "/api/stream?view=list", headers: { Accept: "text/event-stream", Authorization: `Bearer ${d.token}` } }, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        buf += c;
        const m = /(?:^|\n)data: (.*)\n\n/.exec(buf);
        if (m) {
          r.destroy();
          resolve(m[1]);
        }
      });
      res.on("end", () => reject(new Error(`stream ended without data (HTTP ${res.statusCode}): ${buf}`)));
    });
    r.on("error", e => (e.code === "ECONNRESET" ? null : reject(e)));
    r.end();
  });
}

test("HTTP: sessions and the list stream carry the queue; settings carry Testing; saves are guarded", async () => {
  const p = provider();
  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const rows = [{ pid: 100, ppid: 1, lstart: "A" }, { pid: 101, ppid: 100, lstart: "x" }];
  record(p, { pid: 100, pstart: "A", state: "running", queued_at: 1, running_at: 2, payload: 101, label: "vitest", repo: "app", worktree: "wt" });
  let probes = 0;
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalogs: {}, latestVersion: async () => null, updateCache: path.join(tmp, "update.json"), testSlot: p, testRuns: () => (probes++, readTestRuns({ paths: p, processRows: () => rows, step: () => selectStep(STEPS[0].entries) })) });
  try {
    const auth = { Authorization: `Bearer ${d.token}` };
    const sessions = await request(d.port, "/api/sessions", { headers: auth });
    const tests = JSON.parse(sessions.text).tests;
    assert.deepEqual(tests.runs[0].step, { program: "node", script: "./stage.mjs" });
    assert.ok(!sessions.text.includes("SENTINEL"), sessions.text);
    const streamed = await firstListEvent(d);
    assert.deepEqual(JSON.parse(streamed).tests, tests);
    assert.ok(!streamed.includes("SENTINEL"));
    const before = probes;
    for (const route of ["/api/overview", "/api/avatars", "/api/health"]) assert.equal((await request(d.port, route, { headers: auth })).status, 200);
    assert.equal(probes, before, "routes that do not show the queue never read it");
    const settings = JSON.parse((await request(d.port, "/api/settings", { headers: auth })).text);
    assert.deepEqual(settings.testSlot.values, TEST_SLOT_DEFAULTS);

    const origin = { Origin: `http://127.0.0.1:${d.port}`, Cookie: `cr_token=${d.token}`, "Content-Type": "application/json" };
    const post = (body, headers = origin) => request(d.port, "/api/test-slot", { method: "POST", headers, body });
    assert.equal((await post({ key: "TEST_SLOT_JOBS", value: 4 }, { Cookie: `cr_token=${d.token}` })).status, 403, "cookie without Origin");
    assert.equal((await post({ key: "TEST_SLOT_JOBS", value: 4 }, { ...origin, Origin: "http://evil.test" })).status, 403);
    assert.notEqual((await post({ key: "TEST_SLOT_JOBS", value: 4 }, { Origin: origin.Origin })).status, 200, "no token");
    assert.equal((await post({ key: "TEST_SLOT_JOBS", value: 0 })).status, 400);
    assert.equal(fs.existsSync(p.conf), false, "nothing written by refused saves");
    const ok = await post({ key: "TEST_SLOT_JOBS", value: 4 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(JSON.parse(ok.text).values.TEST_SLOT_JOBS, 4);
    assert.equal(fs.readFileSync(p.conf, "utf8"), "TEST_SLOT_JOBS=4\n");
  } finally {
    await d.close();
  }
  const gone = provider({ dir: false });
  const d2 = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalogs: {}, latestVersion: async () => null, updateCache: path.join(tmp, "update.json"), testSlot: gone });
  try {
    const headers = { Origin: `http://127.0.0.1:${d2.port}`, Cookie: `cr_token=${d2.token}`, "Content-Type": "application/json" };
    assert.equal((await request(d2.port, "/api/test-slot", { method: "POST", headers, body: { key: "TEST_SLOT_JOBS", value: 4 } })).status, 409);
    assert.deepEqual(JSON.parse((await request(d2.port, "/api/sessions", { headers: { Authorization: `Bearer ${d2.token}` } })).text).tests, { available: false });
    assert.equal(fs.existsSync(gone.conf), false);
  } finally {
    await d2.close();
  }
});

test("every dashboard fixture, demo and screenshot entry point drops an inherited CROSS_REVIEW_AGENTS_DIR", () => {
  const root = path.join(HERE, "..");
  const entries = ["demo/build.mjs", ...fs.readdirSync(path.join(root, "docs")).map(n => `docs/${n}`), ...fs.readdirSync(HERE).map(n => `tests/${n}`)]
    .filter(f => /\.(m?js)$/.test(f) && f !== "tests/dashboard-test-slot.test.js")
    .filter(f => /startDashboard\(|createListWatcher\(/.test(fs.readFileSync(path.join(root, f), "utf8")));
  assert.ok(entries.length >= 7 && entries.includes("docs/screenshots.mjs"), entries.join(", "));
  for (const f of entries) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(text, /delete process\.env\.CROSS_REVIEW_AGENTS_DIR/, f);
    // os.homedir() reads USERPROFILE on Windows: the fixture HOME must be the profile there too
    assert.match(text, /process\.env\.USERPROFILE = /, f);
  }
});
