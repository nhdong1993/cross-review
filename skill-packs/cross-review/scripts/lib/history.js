// ~/.cross-review/history: one summary per session, written by the runner at each end, so the
// dashboard's History keeps the row after the session folder (a removed worktree) is gone.
// shortcut: never pruned (~1 KB per session), add a cleanup when it passes ~10k files

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, readSession } from "./dashboard/model.js";

export const historyDir = () => path.join(os.homedir(), ".cross-review", "history");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(["approve", "consensus", "stalemate", "stopped"]);

/** Write the summary of the close that just happened; `finalized` false archives it as stopped. */
export function archiveSession(sessionDir, { finalized }) {
  // the canonical folder: its name is the session's public id (an MCP caller may pass an alias)
  const parsed = readSession(fs.realpathSync(sessionDir), { logs: false });
  if (!parsed) throw new Error("cannot read the session state");
  const key = parsed.state.history_key;
  if (typeof key !== "string" || !UUID.test(key)) throw new Error(`invalid history_key ${JSON.stringify(key)}`);
  const { summary: s } = classify(parsed);
  const record = {
    v: 1,
    history_key: key,
    id: s.id,
    skill: s.skill,
    workspace: parsed.state.working_dir,
    title: s.title,
    state: finalized ? s.state : "stopped",
    rounds: s.rounds,
    issues: s.issues,
    issueCount: s.issueCount,
    model: s.model,
    reviewer: s.reviewer,
    reviewerSeconds: s.reviewerSeconds,
    createdAt: s.createdAt,
    endedAt: parsed.state.ended_at || null,
  };
  // never publish what the dashboard would skip: the previous summary stays instead
  if (!validRecord(record)) throw new Error("the summary does not match the archive format");
  const dir = historyDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a link would make the chmod below change some other folder
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  // mode applies on creation only: an existing folder is made private too
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${key}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // created here, exclusively: only a file this writer made is removed on failure
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(record) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

const str = v => typeof v === "string";
const num = v => typeof v === "number" && Number.isFinite(v);
const numOrNull = v => v === null || num(v);

/** A record exactly as archiveSession writes it; anything else is skipped. */
export function validRecord(r) {
  return Boolean(r) && typeof r === "object" && r.v === 1 && str(r.history_key) && UUID.test(r.history_key)
    && str(r.workspace) && path.isAbsolute(r.workspace) && str(r.id) && str(r.skill) && str(r.title)
    && str(r.issues) && str(r.reviewer) && STATES.has(r.state) && num(r.rounds) && num(r.issueCount)
    && num(r.reviewerSeconds) && numOrNull(r.createdAt) && numOrNull(r.endedAt) && (r.model === null || str(r.model));
}

/** Every valid record under its own name, <history_key>.json; throws when the folder cannot be listed. */
export function loadHistory(dir = historyDir()) {
  const records = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      // a copy under another name (a backup, a sync conflict) would list one session twice
      if (validRecord(r) && name === `${r.history_key}.json`) records.push(r);
    } catch {}
  }
  return records;
}
