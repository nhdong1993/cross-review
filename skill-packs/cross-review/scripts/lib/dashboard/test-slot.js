// The machine's heavy-test queue (agent-rules `bin/test-slot`), seen and configured from the dashboard.
// test-slot keeps one private JSON record per outermost run in <agents>/run/test-slot.d while it waits and runs:
// a fixed task label, repo/worktree names, state and times, never the command line. This module only reads those
// records, and writes one file: <agents>/test-slot.conf, the queue's saved defaults.
//
//   testSlotPaths() → {root, dir, lock, conf}        readTestRuns() → {available, error?, runs}
//   readTestSlotConf() → {available, values, saved, invalid}    saveTestSlotKey(key, value) → readTestSlotConf()

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TEST_SLOT_KEYS = ["TEST_SLOT_JOBS", "TEST_SLOT_WAIT", "TEST_SLOT_KILL_GRACE"];
export const TEST_SLOT_DEFAULTS = { TEST_SLOT_JOBS: 2, TEST_SLOT_WAIT: 100, TEST_SLOT_KILL_GRACE: 10 };

/** Where test-slot lives: CROSS_REVIEW_AGENTS_DIR, else ~/.agents. Queue, records and config share that root. */
export function testSlotPaths(env = process.env) {
  const root = env.CROSS_REVIEW_AGENTS_DIR || path.join(os.homedir(), ".agents");
  return { root, dir: path.join(root, "run", "test-slot.d"), lock: path.join(root, "run", "test-slot.lock"), conf: path.join(root, "test-slot.conf") };
}

/** "yes" when the lock exists and the record directory is a directory (agent-rules README setup step), "no" when
 *  either is missing, "error" when they cannot be checked (permissions, I/O): unknown is never shown as absent. */
export function testSlotState(p = testSlotPaths()) {
  try {
    if (!fs.statSync(p.dir).isDirectory()) return "no";
    fs.statSync(p.lock);
    return "yes";
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? "no" : "error";
  }
}

// ---- saved defaults: the same contract as bin/test-slot (and its selftest's fixture table) ----

/** A saved value as test-slot reads it: digits only, leading zeros dropped, at most 15 digits, jobs >= 1,
 *  wait <= 4294967295. Returns the number, or null when test-slot would ignore it. */
export function savedValue(key, raw) {
  // a digit string (as in the file) or a whole number (as JSON sends it); never an array, object, boolean or null
  if (typeof raw === "number" && !(Number.isSafeInteger(raw) && raw >= 0)) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw);
  if (!/^[0-9]+$/.test(s)) return null;
  const x = s.replace(/^0+/, "") || "0";
  if (x.length > 15) return null;
  const n = Number(x);
  if (key === "TEST_SLOT_JOBS" && n < 1) return null;
  if (key === "TEST_SLOT_WAIT" && n > 4294967295) return null;
  return n;
}

/** {saved: valid saved values by key, invalid: whether test-slot would warn about the file}. Last duplicate wins. */
export function parseTestSlotConf(text) {
  const raw = Object.create(null);
  let invalid = false;
  for (let line of text.split("\n")) {
    line = line.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) continue;
    // the key is recognised whatever its value holds (a stray CR or U+2028 too), as test-slot does; the value is checked below
    const m = /^(TEST_SLOT_JOBS|TEST_SLOT_WAIT|TEST_SLOT_KILL_GRACE)=([\s\S]*)$/.exec(line);
    if (m) raw[m[1]] = m[2];
    else invalid = true;
  }
  const saved = {};
  for (const k of TEST_SLOT_KEYS) {
    if (!(k in raw)) continue;
    const v = savedValue(k, raw[k]);
    if (v === null) invalid = true;
    else saved[k] = v;
  }
  return { saved, invalid };
}

/** The Testing settings: what a run without TEST_SLOT_* in its environment would use. */
export function readTestSlotConf(p = testSlotPaths()) {
  const state = testSlotState(p);
  if (state === "no") return { available: false };
  if (state === "error") return { available: true, error: true };
  let text = "";
  try {
    text = fs.readFileSync(p.conf, "latin1"); // bytes, as test-slot reads them; the keys and digits are ASCII
  } catch (e) {
    if (e.code !== "ENOENT") return { available: true, error: true };
  }
  const { saved, invalid } = parseTestSlotConf(text);
  return { available: true, values: { ...TEST_SLOT_DEFAULTS, ...saved }, saved, invalid };
}

export class TestSlotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LOCK_WAIT_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start time of `pid` as ps prints it (fixed locale and zone, single spaces), "" when unknown. */
function startTime(pid) {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

const DAYS = "Sun|Mon|Tue|Wed|Thu|Fri|Sat";
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
/** The instant (ms) of a start time as `LC_ALL=C TZ=UTC ps -o lstart=` prints it, or null when it is not a real
 *  date in that form (an impossible day, a weekday that does not match): never proof of anything. */
function startInstant(s) {
  const m = new RegExp(`^(${DAYS}) (${MONTHS}) (\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`).exec(String(s).trim().replace(/\s+/g, " "));
  if (!m) return null;
  const [, wd, mon, d, h, mi, se, y] = m;
  const t = Date.UTC(+y, MONTHS.split("|").indexOf(mon), +d, +h, +mi, +se);
  const back = new Date(t);
  const same = back.getUTCDate() === +d && back.getUTCHours() === +h && back.getUTCMinutes() === +mi && back.getUTCSeconds() === +se;
  return same && DAYS.split("|")[back.getUTCDay()] === wd ? t : null;
}

// Why the config lock is held, for the 409 the page shows. Never steals it: a paused writer would lose its save.
// Says the owner is gone only on proof (no such pid, or that pid started at another time); unknown is not proof.
export function lockHolder(lock, startOf = startTime) {
  const ask = `Stop every dashboard, then delete ${lock} and try again.`;
  let text = "";
  try {
    text = fs.readFileSync(lock, "utf8");
  } catch {}
  // "<pid> <start time as ps -o lstart= prints it>"; anything else names no owner we can check
  const m = /^([1-9]\d{0,9}) (.+)\n?$/.exec(text);
  const recorded = m && Number(m[1]) <= 2 ** 31 - 1 && startInstant(m[2]);
  if (!recorded) return `The Testing settings are locked by ${lock}, which names no owner that can be checked. ${ask}`;
  // only "no such process" proves the owner gone; "not permitted" means alive; anything else is unknown
  let alive = true;
  try {
    process.kill(Number(m[1]), 0);
  } catch (e) {
    if (e.code === "ESRCH") alive = false;
    else if (e.code !== "EPERM") return `The Testing settings are locked by process ${m[1]}, which could not be checked. ${ask}`;
  }
  const started = alive ? startInstant(startOf(m[1])) : null;
  if (alive && started === recorded) return "Another dashboard is saving the Testing settings. Try again.";
  if (alive && !started) return `The Testing settings are locked by process ${m[1]}, which could not be checked. ${ask}`;
  return `A dashboard that stopped while saving left ${lock} behind. Delete that file, then try again.`;
}

/** Remove a temp file, trying a few times (a transient I/O error should not leave it behind); false if it stays. */
function removeTemp(file) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return true;
    }
  }
  return false;
}

/** Write `text` to a new private file at `file`. The file is ours only once the exclusive open succeeds (a file that
 *  was already there is never touched); if the write then fails it is removed with retries, the write's error is
 *  kept, and a file that would not go is named in `error.leftover`. */
function writeNew(file, text) {
  const fd = fs.openSync(file, "wx", 0o600);
  let error = null;
  try {
    fs.writeFileSync(fd, text);
  } catch (e) {
    error = e; // the write's own error stays the cause, whatever closing does
  }
  try {
    fs.closeSync(fd);
  } catch (e) {
    error = error || e;
  }
  if (error) {
    if (!removeTemp(file)) error.leftover = file;
    throw error;
  }
}

/** Save one Testing key into the config file as it is now, keeping every other line; one writer at a time. */
export async function saveTestSlotKey(key, value, p = testSlotPaths()) {
  if (!TEST_SLOT_KEYS.includes(key)) throw new TestSlotError(400, `key must be one of ${TEST_SLOT_KEYS.join(", ")}`);
  const n = savedValue(key, value);
  if (n === null) throw new TestSlotError(400, key === "TEST_SLOT_JOBS" ? "Workers must be a whole number from 1" : key === "TEST_SLOT_WAIT" ? "Wait must be a whole number of seconds up to 4294967295" : "Kill grace must be a whole number of seconds");
  const state = testSlotState(p);
  if (state !== "yes") throw new TestSlotError(409, state === "no" ? "test-slot is not set up on this machine" : `cannot read ${p.dir}`);
  // The lock is published complete (owner pid and start time) by linking a finished private file, as token.js does
  const lock = `${p.conf}.lock`;
  const temp = `${lock}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(temp, `${process.pid} ${startTime(process.pid)}\n`);
  } catch (e) {
    if (!e.leftover) throw e;
    throw new TestSlotError(500, `${e.code || "error"} writing ${p.conf}. Not saved, and ${e.leftover} could not be removed: delete it by hand.`);
  }
  // shortcut: a lock left by a dashboard that died mid-save must be deleted by hand; the write window is a few ms
  //   and usually one dashboard runs. Upgrade if that message is ever seen.
  let locked = false; // only a lock this call published is ever removed here
  let tempLeft = false;
  let lockLeft = false;
  let failure = null;
  let out = null; // the new config's own temp, until the rename makes it the config
  let written = "";
  try {
    try {
      const until = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          fs.linkSync(temp, lock);
          locked = true;
          break;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          if (Date.now() >= until) throw new TestSlotError(409, lockHolder(lock));
          await sleep(50);
        }
      }
    } finally {
      tempLeft = !removeTemp(temp);
    }
    // removing run/test-slot.d switches the integration off: a save that waited meanwhile writes nothing
    const now = testSlotState(p);
    if (now !== "yes") throw new TestSlotError(409, now === "no" ? "test-slot is not set up on this machine" : `cannot read ${p.dir}`);
    let text = "";
    try {
      text = fs.readFileSync(p.conf, "latin1"); // one char per byte: lines not edited are written back unchanged
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // Each line keeps its own ending (\r\n, \n, or none at the end). The key's first line gets the new value with
    // that line's ending, its other lines go whole, every other line stays byte for byte; a new key is added last,
    // after a line break only if the last line had none.
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const line = `${key}=${n}`;
    const kept = [];
    let placed = false;
    for (const l of lines) {
      if (!l.startsWith(`${key}=`)) kept.push(l);
      else if (!placed) (kept.push(line + (l.match(/\r?\n$|\r$/) || [""])[0]), (placed = true));
    }
    if (!placed) {
      if (kept.length && !kept[kept.length - 1].endsWith("\n")) kept[kept.length - 1] += "\n";
      kept.push(`${line}${text === "" || text.endsWith("\n") ? "\n" : ""}`);
    }
    const candidate = `${p.conf}.${process.pid}.${crypto.randomUUID()}.tmp`;
    written = kept.join("");
    try {
      writeNew(candidate, Buffer.from(written, "latin1"));
    } catch (e) {
      out = e.leftover || null; // ours only if we created it and it would not go
      throw e;
    }
    out = candidate;
    fs.renameSync(out, p.conf);
    out = null; // it is the config now
  } catch (e) {
    failure = e;
  } finally {
    // retried; a failure here never replaces the save's own outcome (its error, or the saved values below)
    if (locked) lockLeft = !removeTemp(lock);
    if (tempLeft) tempLeft = !removeTemp(temp);
    if (out && removeTemp(out)) out = null;
  }
  // files this call made that are still there: the shared lock needs every dashboard stopped first, the temps do not
  const left = [lockLeft && `${lock} (stop every dashboard first)`, tempLeft && temp, out].filter(Boolean);
  if (failure) {
    // the save's own error, plus what is left to delete: a stuck lock would block every retry
    if (!left.length) throw failure;
    const why = failure instanceof TestSlotError ? failure.message : `${failure.code || "error"} writing ${p.conf}`;
    throw new TestSlotError(failure.status || 500, `${why}. Not saved, and ${left.join(" and ")} could not be removed: delete it by hand.`);
  }
  // the values come from the bytes just written, so a read that fails now cannot hide that the save happened
  const { saved, invalid } = parseTestSlotConf(written);
  const result = { available: true, values: { ...TEST_SLOT_DEFAULTS, ...saved }, saved, invalid };
  return left.length ? { ...result, warning: `Saved. ${left.join(" and ")} could not be removed: delete it by hand.` } : result;
}

// ---- runs ----

/** Every process as {pid, ppid, lstart}, or null when ps fails. One call per snapshot, without arguments. */
export function psRows() {
  let out;
  try {
    out = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3].replace(/\s+/g, " ") });
  }
  return rows;
}

const INTERPRETER = /^(node|python[0-9.]*|deno|ruby|bash|sh|zsh)$/i;
const SCRIPT = /\.(js|mjs|cjs|ts|py|sh|rb)$/;

/** The running step from candidates' {exe, argv} (deepest first, payload last; null = unreadable): the first
 *  interpreter whose first argument is a script path gives {program, script}, or {program} alone when that path
 *  holds `:`, `?` or `#` (it may be a URL with a query, e.g. Node's --entry-url); else the payload's program.
 *  Mirrored by procargs.py; both are checked against tests/helpers/fixtures/test-slot-steps.json. */
export function selectStep(entries) {
  return pickStep(entries.length, i => entries[i]);
}

/** selectStep over `n` candidates read one at a time by `at(i)`, stopping at the first script. Each candidate's
 *  arguments are dropped once looked at; only the payload's (last) program name is kept for the fallback. */
function pickStep(n, at) {
  let payload = null;
  for (let i = 0; i < n; i++) {
    const e = at(i);
    if (!e || !e.exe) continue;
    if (i === n - 1) payload = path.basename(e.exe);
    const program = path.basename(e.exe);
    if (!INTERPRETER.test(program)) continue;
    const op = e.argv && e.argv[1];
    if (typeof op !== "string" || op.startsWith("-") || !SCRIPT.test(op)) continue;
    // shortcut: a script whose name holds : ? # shows only its program, since it cannot be told from a URL
    return /[:?#]/.test(op) ? { program } : { program, script: op };
  }
  return payload ? { program: payload } : null;
}

const PROCARGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "procargs.py");

/** readStep for this platform: pids (deepest first, payload last) → {program, script?} | null. Raw arguments are
 *  read in memory and never leave it. */
export function readStep(pids) {
  if (process.platform === "darwin") {
    try {
      return JSON.parse(execFileSync("/usr/bin/python3", ["-I", PROCARGS, ...pids.map(String)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    return pickStep(pids.length, i => {
      try {
        const argv = fs.readFileSync(`/proc/${pids[i]}/cmdline`, "utf8").split("\0");
        if (argv[argv.length - 1] === "") argv.pop();
        return { exe: fs.readlinkSync(`/proc/${pids[i]}/exe`), argv };
      } catch {
        return null;
      }
    });
  }
  // shortcut: no step on other platforms; upgrade if test-slot ever runs there
  return null;
}

/** The payload's process tree, deepest first (ties: higher pid first), payload last; [] when the payload the record
 *  names is gone or is no longer the wrapper's child. */
export function stepCandidates(rows, wrapperPid, payload) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  if (!Number.isInteger(payload) || !(kids.get(wrapperPid) || []).includes(payload)) return [];
  const out = [];
  const seen = new Set([payload]);
  let level = [payload];
  for (let depth = 0; level.length; depth++) {
    for (const pid of level) out.push({ pid, depth });
    const next = [];
    for (const pid of level) for (const c of kids.get(pid) || []) if (!seen.has(c)) (seen.add(c), next.push(c));
    level = next;
  }
  return out.sort((a, b) => b.depth - a.depth || b.pid - a.pid).map(c => c.pid);
}

const STATES = new Set(["waiting", "running"]);
const nonNeg = x => Number.isFinite(x) && x >= 0;
const str = x => (typeof x === "string" ? x : "");

/** The queue now: running first, then waiting by the time they queued. Records whose pid is gone or now belongs to
 *  another process are skipped (never deleted: the wrapper prunes them). */
export function readTestRuns({ paths = testSlotPaths(), processRows = psRows, step = readStep } = {}) {
  const state = testSlotState(paths);
  if (state === "no") return { available: false };
  if (state === "error") return { available: true, error: true, runs: [] };
  let names;
  try {
    names = fs.readdirSync(paths.dir).filter(n => /^\d+\.json$/.test(n));
  } catch {
    return { available: true, error: true, runs: [] };
  }
  const recs = [];
  for (const n of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(paths.dir, n), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") continue; // finished between listing and reading
      return { available: true, error: true, runs: [] };
    }
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      continue; // half-written by a writer that died
    }
    if (!r || r.v !== 1 || !Number.isInteger(r.pid) || `${r.pid}.json` !== n || !STATES.has(r.state) || typeof r.pstart !== "string" || !nonNeg(r.queued_at)) continue;
    if (r.state === "running" && !nonNeg(r.running_at)) continue;
    recs.push(r);
  }
  if (!recs.length) return { available: true, runs: [] };
  const rows = processRows();
  if (!rows) return { available: true, error: true, runs: [] };
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const runs = [];
  for (const r of recs) {
    const row = byPid.get(r.pid);
    if (!row || row.lstart !== r.pstart.replace(/\s+/g, " ").trim()) continue;
    const run = { pid: r.pid, state: r.state, label: str(r.label) || "custom", repo: str(r.repo), worktree: str(r.worktree), queuedAt: r.queued_at, runningAt: r.state === "running" ? r.running_at : null, step: null };
    if (r.state === "running") {
      const pids = stepCandidates(rows, r.pid, r.payload);
      if (pids.length) run.step = step(pids);
    }
    runs.push(run);
  }
  runs.sort((a, b) => (a.state === b.state ? a.queuedAt - b.queuedAt || a.pid - b.pid : a.state === "running" ? -1 : 1));
  return { available: true, runs };
}
