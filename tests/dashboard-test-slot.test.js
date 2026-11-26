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

import { lockHolder, parseTestSlotConf, psRows, readHistory, readStep, readTestRuns, readTests, readTestSlotConf, saveTestSlotKey, selectStep, stepCandidates, testSlotPaths, TEST_SLOT_DEFAULTS } from "../skill-packs/cross-review/scripts/lib/dashboard/test-slot.js";
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

// ---- observation (agent-rules' observer): usage, estimates, shadow decision, machine figures, history ----

const S1 = "Wed Nov 25 10:00:00 2026", S2 = "Wed Nov 25 10:00:01 2026", S3 = "Wed Nov 25 10:00:02 2026", SO = "Wed Nov 25 09:00:00 2026";
const runRootOf = p => path.dirname(p.dir);
const observerFile = (p, doc) => fs.writeFileSync(path.join(runRootOf(p), "test-slot.observer.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
const historyFile = p => path.join(runRootOf(p), "test-slot.history.jsonl");
/** A sample of observer 900 for the queue of `observed()`: 100 runs, 300 is the head (queued first), 200 waits. */
function sample(over = {}) {
  return {
    v: 1, pid: 900, pstart: SO, at: 1000, dt: 5, cost: { ticks: 3, cpu_s: 0.1 },
    host: { ncpu: 14, idle_cores: 9.5, pressure: 2, avail_mb: 3000, swapout_pages_s: 0, swapin_pages_s: 12.5 },
    vm: { n: 2, cpu_pct: 140.5, mem_mb: 1400.2, mem_low: false },
    runs: [{ pid: 100, pstart: S1, tree: { n: 3, cpu_pct: 210.5, mem_mb: 812.4, rss_mb: 300.1, mem_low: false }, peak: { cpu_pct: 260, mem_mb: 900.5, samples: 7, mem_low: false }, partial: false, key: "KEYSEED", repo_id: "REPOSEED", heads: { ids: { "300:IDSEED": true } } }],
    pending: [{ pid: 55, pstart: "PENDINGSEED" }],
    waiters: [{ pid: 200, pstart: S2, est_state: "measured", est_mb: 600, est_cores: 2.2, est_s: 40, est_n: 5 }, { pid: 300, pstart: S3, est_state: "unmeasured", est_mb: null, est_cores: null, est_s: null, est_n: null }],
    shadow: { pid: 300, pstart: S3, incumbent: { pid: 100, pstart: S1 }, passed: false, reason: "memory" },
    ...over,
  };
}
const ROWS = [{ pid: 100, ppid: 1, stat: "S", lstart: S1 }, { pid: 200, ppid: 1, stat: "S", lstart: S2 }, { pid: 300, ppid: 1, stat: "S", lstart: S3 }, { pid: 900, ppid: 1, stat: "SN", lstart: SO }];
function observed({ doc = sample(), rows = ROWS, now = 1003, records = true } = {}) {
  const p = provider();
  if (records) {
    record(p, { pid: 100, pstart: S1, state: "running", queued_at: 30, running_at: 35, payload: 101 });
    record(p, { pid: 200, pstart: S2, state: "waiting", queued_at: 50 });
    record(p, { pid: 300, pstart: S3, state: "waiting", queued_at: 40 });
  }
  if (doc !== null) observerFile(p, doc);
  let ps = 0;
  const out = readTests({ paths: p, processRows: () => (ps++, rows), step: () => null, now });
  return { out, ps, p, run: pid => out.runs.find(r => r.pid === pid) };
}

test("observation: a fresh sample gives usage, estimates, the head's decision and machine figures", () => {
  const { out, run } = observed();
  assert.equal(out.observer, "running");
  assert.deepEqual(run(100).usage, { at: 1000, tree: { n: 3, cpuPct: 210.5, memMb: 812.4, rssMb: 300.1, memLow: false }, peak: { cpuPct: 260, memMb: 900.5, samples: 7, memLow: false }, partial: false });
  assert.deepEqual(run(200).est, { state: "measured", mb: 600, cores: 2.2, seconds: 40, n: 5 });
  assert.deepEqual(run(300).est, { state: "unmeasured", mb: null, cores: null, seconds: null, n: null });
  assert.deepEqual(run(300).shadow, { passed: false, reason: "memory" }, "the head is the waiter queued first");
  assert.equal("shadow" in run(200), false);
  assert.deepEqual(out.host, { ncpu: 14, idleCores: 9.5, pressure: 2, availMb: 3000, swapoutPagesS: 0, swapinPagesS: 12.5 });
  assert.deepEqual(out.vm, { n: 2, cpuPct: 140.5, memMb: 1400.2, memLow: false });
  assert.deepEqual(out.history, []);
  // other numbers give other figures; a real zero stays zero, a missing or bad figure is null, never 0
  const b = observed({ doc: sample({ runs: [{ pid: 100, pstart: S1, tree: { n: 1, cpu_pct: 0, mem_mb: 5.5, rss_mb: -1, mem_low: true }, peak: { cpu_pct: "9", mem_mb: Infinity, samples: 1 }, partial: true }], host: { ncpu: 8, idle_cores: null, pressure: 1, avail_mb: "x" } }) });
  assert.deepEqual(b.run(100).usage, { at: 1000, tree: { n: 1, cpuPct: 0, memMb: 5.5, rssMb: null, memLow: true }, peak: { cpuPct: null, memMb: null, samples: 1, memLow: false }, partial: true });
  assert.deepEqual(b.out.host, { ncpu: 8, idleCores: null, pressure: 1, availMb: null, swapoutPagesS: null, swapinPagesS: null });
  const c = observed({ doc: sample({ runs: [{ pid: 100, pstart: S1, tree: null, peak: { cpu_pct: 1, mem_mb: 2, samples: 3 } }] }) });
  assert.equal(c.run(100).usage.tree, null, "a tick without a tree stays missing");
});

test("observation: figures are joined by pid and start time, never by pid alone", () => {
  const a = observed({ doc: sample({ runs: [{ ...sample().runs[0], pstart: "Wed Nov 25 08:00:00 2026" }] }) });
  assert.equal(a.run(100).usage, null);
  assert.equal("shadow" in a.run(300), true, "the decision names its incumbent itself");
  const b = observed({ doc: sample({ waiters: [{ ...sample().waiters[0], pstart: "x" }] }) });
  assert.equal(b.run(200).est, null);
  const c = observed({ doc: sample({ waiters: [{ ...sample().waiters[0], est_state: "certain" }] }) });
  assert.equal(c.run(200).est, null, "an unknown estimate state is not passed on");
  const d = observed({ doc: sample({ shadow: { ...sample().shadow, pstart: "x" } }) });
  assert.equal(d.out.runs.some(r => "shadow" in r), false);
});

test("observation: one validity decision for the sample: fresh, expired or unusable", () => {
  const live = o => ({ usage: o.run(100).usage, est: o.run(200).est, shadow: o.out.runs.some(r => "shadow" in r), host: o.out.host, vm: o.out.vm, observer: o.out.observer });
  const stale = { usage: { stale: true }, est: null, shadow: false, host: null, vm: null, observer: "absent" };
  const none = { ...stale, usage: null };
  assert.deepEqual(live(observed({ now: 1016 })), stale, "16 s old: expired");
  assert.equal(observed({ now: 1015 }).out.observer, "running", "15 s old: fresh");
  assert.equal(observed({ now: 995 }).out.observer, "running", "5 s ahead: fresh");
  assert.deepEqual(live(observed({ now: 994 })), none, "6 s ahead: unusable");
  assert.deepEqual(live(observed({ doc: null })), none, "no file");
  assert.deepEqual(live(observed({ doc: "{half" })), none, "malformed");
  assert.deepEqual(live(observed({ doc: sample({ v: 2 }) })), none, "another version");
  assert.deepEqual(live(observed({ rows: ROWS.slice(0, 3) })), none, "the observer's pid is not running");
  assert.deepEqual(live(observed({ rows: [...ROWS.slice(0, 3), { pid: 900, ppid: 1, stat: "S", lstart: S1 }] })), none, "its pid belongs to another process");
  // identity is rejected even for an old sample: not "stale data of the right observer"
  assert.deepEqual(live(observed({ now: 1016, rows: ROWS.slice(0, 3) })), none);
});

test("observation: an empty queue starts no ps; freshness alone says whether the observer runs", () => {
  for (const [now, want] of [[994, "absent"], [995, "running"], [1015, "running"], [1016, "absent"]]) {
    const { out, ps, p } = observed({ records: false, now });
    fs.writeFileSync(historyFile(p), "");
    assert.equal(ps, 0, "no process table for an empty queue");
    assert.equal(out.observer, want, `age ${now - 1000}`);
    assert.deepEqual(out.runs, []);
    assert.deepEqual(out.history, [], "history does not depend on the observer");
  }
  assert.equal(observed({ records: false, doc: null }).out.observer, "absent");
});

test("observation: a decision is attached only to the pair it was computed for", () => {
  const forHead = pid => ({ ...sample().shadow, pid, pstart: pid === 200 ? S2 : S3, passed: true, reason: "passed" });
  const has = o => o.out.runs.filter(r => "shadow" in r).map(r => r.pid);
  assert.deepEqual(has(observed({ doc: sample({ shadow: forHead(200) }) })), [], "200 is not the first eligible waiter");
  // an older stopped waiter does not outrank the sampled head, and is head again when continued
  const stopped = observed({ doc: sample({ shadow: forHead(200) }), rows: ROWS.map(r => (r.pid === 300 ? { ...r, stat: "T" } : r)) });
  assert.deepEqual(has(stopped), [200]);
  assert.equal(stopped.run(300).stopped, true);
  const zombieWaiter = observed({ doc: sample({ shadow: forHead(200) }), rows: ROWS.map(r => (r.pid === 300 ? { ...r, stat: "Z" } : r)) });
  assert.deepEqual(has(zombieWaiter), [200]);
  assert.equal(zombieWaiter.run(300).exited, true);
  // the incumbent of the decision must still be a running row that has not exited
  const gone = observed({ doc: sample({ shadow: forHead(300) }) });
  fs.unlinkSync(path.join(gone.p.dir, "100.json"));
  assert.deepEqual(readTests({ paths: gone.p, processRows: () => ROWS, step: () => null, now: 1003 }).runs.filter(r => "shadow" in r), [], "its incumbent left the queue");
  assert.deepEqual(has(observed({ doc: sample({ shadow: { ...forHead(300), incumbent: { pid: 100, pstart: "x" } } }) })), [], "another run holds that pid now");
  const holderT = observed({ doc: sample({ shadow: forHead(300) }), rows: ROWS.map(r => (r.pid === 100 ? { ...r, stat: "T" } : r)) });
  assert.deepEqual(has(holderT), [300], "a stopped holder still holds the slot");
  assert.equal(holderT.run(100).usage.peak.memMb, 900.5);
});

test("observation: a holder that exited gets no usage and is nobody's incumbent, whatever the sample says", () => {
  const withSuccessor = (now, stat) => {
    const p = provider();
    record(p, { pid: 100, pstart: S1, state: "running", queued_at: 30, running_at: 35, payload: 101 });
    record(p, { pid: 150, pstart: S2, state: "running", queued_at: 31, running_at: 60, payload: 151 });
    record(p, { pid: 300, pstart: S3, state: "waiting", queued_at: 40 });
    observerFile(p, sample({ runs: [sample().runs[0], { ...sample().runs[0], pid: 150, pstart: S2 }], shadow: { ...sample().shadow, passed: true, reason: "passed" } }));
    const rows = [{ pid: 100, ppid: 1, stat, lstart: S1 }, { pid: 150, ppid: 1, stat: "S", lstart: S2 }, { pid: 300, ppid: 1, stat: "S", lstart: S3 }, { pid: 900, ppid: 1, stat: "S", lstart: SO }];
    const out = readTests({ paths: p, processRows: () => rows, step: () => null, now });
    return pid => out.runs.find(r => r.pid === pid);
  };
  let run = withSuccessor(1003, "Z");
  assert.equal(run(100).exited, true);
  assert.equal(run(100).usage, null);
  assert.equal(run(150).usage.peak.samples, 7);
  assert.equal("shadow" in run(300), false, "the decision was computed against the former holder");
  run = withSuccessor(1003, "T");
  assert.equal("shadow" in run(300), true);
  assert.notEqual(run(100).usage, null);
  // expired sample: the exited holder has no usage at all, its live successor's is stale
  run = withSuccessor(1030, "Z");
  assert.equal(run(100).usage, null);
  assert.deepEqual(run(150).usage, { stale: true });
});

test("observation: waiting only: estimate and machine figures without a running record, and no decision", () => {
  const p = provider();
  record(p, { pid: 200, pstart: S2, state: "waiting", queued_at: 50 });
  observerFile(p, sample({ runs: [], shadow: null }));
  const out = readTests({ paths: p, processRows: () => ROWS, step: () => null, now: 1003 });
  assert.equal(out.runs[0].est.state, "measured");
  assert.equal(out.host.availMb, 3000);
  assert.equal("shadow" in out.runs[0], false);
  // a stale pass for a pair that no longer exists is not shown on a waiting-only queue either
  observerFile(p, sample({ runs: [], shadow: { pid: 200, pstart: S2, incumbent: { pid: 100, pstart: S1 }, passed: true, reason: "passed" } }));
  assert.equal("shadow" in readTests({ paths: p, processRows: () => ROWS, step: () => null, now: 1003 }).runs[0], false);
});

test("observation: an unreadable queue still reports history and no live figure", () => {
  const p = provider();
  record(p, { pid: 100, pstart: S1, state: "running", queued_at: 30, running_at: 35, payload: 101 });
  observerFile(p, sample());
  const out = readTests({ paths: p, processRows: () => null, step: () => null, now: 1003 });
  assert.deepEqual(out, { available: true, error: true, runs: [], observer: "absent", host: null, vm: null, history: [] });
  assert.deepEqual(readTests({ paths: provider({ dir: false }), processRows: () => ROWS }), { available: false });
});

const hline = (i, over = {}) => JSON.stringify({ v: 1, id: `IDSEED-${i}`, key: "KEYSEED", repo_id: "REPOSEED", started_at: i * 10, ended_at: i * 10 + 5, repo: "app", worktree: "wt", label: "vitest", queued_at: i * 10 - 2, wait_s: 2, dur_s: 5, exit: 0, est_mb: 512, est_cores: 2, peak: { mem_mb: 300.5 + i, cpu_pct: 120, samples: 3, mem_low: false }, partial: false, vm: null, overlapped: false, heads_total: 1, heads_passed: 1, heads_exact: true, shadow: [{ repo: "DETAILSEED", label: "x", passed: true, reason: "passed", samples: 2 }], shadow_truncated: false, ...over });

test("history: the newest 20 runs, newest first, validated, without keys, ids or shadow detail", () => {
  const p = provider();
  assert.deepEqual(readHistory(p), [], "no file: an empty history");
  const lines = [JSON.stringify({ v: 1, snapshot: true, lines: 30, overflow: false, state: { KEYSEED: { budget_mb: 900, fits: 1 } } })];
  for (let i = 1; i <= 30; i++) lines.push(hline(i));
  lines.push("{torn", JSON.stringify({ v: 2, ended_at: 9999 }), JSON.stringify({ v: 1, ended_at: "soon" }));
  lines.push(hline(31, { exit: 17, partial: true, est_mb: null, peak: null, heads_total: 200, heads_passed: 3, heads_exact: false, shadow: Array(20).fill({ repo: "DETAILSEED" }) }));
  lines.push(hline(32, { peak: { mem_mb: 700, cpu_pct: null, samples: 2, mem_low: true }, wait_s: -1, heads_total: 21, heads_passed: 1 }));
  fs.writeFileSync(historyFile(p), lines.join("\n") + "\n");
  const h = readHistory(p);
  assert.equal(h.length, 20);
  assert.deepEqual(h.map(r => r.endedAt), Array.from({ length: 20 }, (_, i) => (32 - i) * 10 + 5));
  assert.deepEqual(h[0], { endedAt: 325, repo: "app", worktree: "wt", label: "vitest", waitS: null, durS: 5, exit: 0, peakMemMb: 700, peakCpuPct: null, memLow: true, estMb: 512, partial: false, heads: 21, headsPassed: 1, headsExact: true });
  assert.deepEqual(h[1], { endedAt: 315, repo: "app", worktree: "wt", label: "vitest", waitS: 2, durS: 5, exit: 17, peakMemMb: null, peakCpuPct: null, memLow: false, estMb: null, partial: true, heads: 200, headsPassed: 3, headsExact: false });
  // through the whole reader, with a live queue: nothing private reaches the payload
  record(p, { pid: 100, pstart: S1, state: "running", queued_at: 30, running_at: 35, payload: 101 });
  observerFile(p, sample());
  const text = JSON.stringify(readTests({ paths: p, processRows: () => ROWS, step: () => null, now: 1003 }));
  for (const seed of ["KEYSEED", "REPOSEED", "IDSEED", "DETAILSEED", "PENDINGSEED"]) assert.equal(text.includes(seed), false, seed);
  assert.equal(JSON.parse(text).history.length, 20);
});

test("history: runs that ended in the same second keep the order they were written in", () => {
  const p = provider();
  fs.writeFileSync(historyFile(p), [hline(1, { label: "first" }), hline(1, { label: "second" }), hline(1, { label: "third" })].join("\n") + "\n");
  assert.deepEqual(readHistory(p).map(r => r.label), ["third", "second", "first"]);
});

test("history: read whole or not at all; an unchanged file is read once", () => {
  const p = provider();
  fs.writeFileSync(historyFile(p), hline(1) + "\n");
  let reads = 0;
  const spy = (...a) => (reads++, fs.readFileSync(...a));
  assert.equal(readHistory(p, spy).length, 1);
  assert.equal(readHistory(p, spy).length, 1);
  assert.equal(reads, 1, "size and mtime unchanged: served from memory");
  fs.appendFileSync(historyFile(p), hline(2) + "\n");
  assert.equal(readHistory(p, spy).length, 2);
  assert.equal(reads, 2, "re-read after an append");
  fs.writeFileSync(historyFile(p), "\n".repeat(2 * 1024 * 1024 + 1));
  assert.equal(readHistory(p, spy), null, "larger than the observer ever writes: unknown");
  assert.equal(reads, 2, "and not read at all");
  fs.rmSync(historyFile(p));
  fs.mkdirSync(historyFile(p));
  assert.equal(readHistory(p), null, "not a regular file");
});
