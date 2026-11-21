import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixture, writeSession } from "./helpers/dashboard-fixture.js";
import { classify, readSession, parseAgentReply, inputValues, TEXT, LABELS } from "../skill-packs/cross-review/scripts/lib/dashboard/model.js";
import { humanize, groupReads, attachTimes, unwrapShell } from "../skill-packs/cross-review/scripts/lib/dashboard/activity.js";
import { activityItems } from "../skill-packs/cross-review/scripts/lib/reviewers/codex.js";

let tmp;
let fx;
const LIVE = 4242;
const isAlive = pid => pid === LIVE;
const at = (key, now = fx.now) => classify(readSession(fx.sessions[key]), { now, isAlive });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-model-"));
  fx = buildFixture(tmp, { now: 1_800_000_000, livePid: LIVE });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- 1, 2, 11: Table 1 ----------

test("each row of the status table classifies its fixture session", () => {
  const cases = [
    ["approved", "history", "approve", "approved"],
    ["running", "active", "running", "reviewer working"],
    ["waiting", "active", "waiting", "agent's turn"],
    ["stopped", "active", "stopped", "stopped, resumable"],
    ["stalemate", "history", "stalemate", "stalemate"],
    ["noReply", "history", "waiting", "no reply"],
    ["stoppedOld", "history", "stopped", "stopped"],
    ["endedOpen", "history", "stopped", "stopped"],
    ["think", "history", "consensus", "consensus"],
    ["pr", "active", "waiting", "agent's turn"],
  ];
  for (const [key, group, state, label] of cases) {
    const { summary } = at(key);
    assert.deepEqual([summary.group, summary.state, summary.label], [group, state, label], key);
  }
});

test("time alone moves a session: warn at 20 minutes, history after 1 hour (same parsed data)", () => {
  const parsed = readSession(fx.sessions.warn);
  const completed = parsed.rounds[0].entry.completed_at;
  const c = now => classify(parsed, { now, isAlive }).summary;
  assert.equal(c(completed + 1199).warn, null);
  assert.equal(c(completed + 1201).warn, TEXT.warn);
  assert.equal(c(completed + 3599).group, "active");
  const late = c(completed + 3601);
  assert.deepEqual([late.group, late.label], ["history", LABELS.noReply]);
  assert.equal(classify(parsed, { now: completed + 3601, isAlive }).detail.status.next, "No reply for over an hour.");

  const stopped = readSession(fx.sessions.stopped);
  const end = stopped.rounds.at(-1).entry.completed_at;
  assert.equal(classify(stopped, { now: end + 3599, isAlive }).summary.group, "active");
  const old = classify(stopped, { now: end + 3601, isAlive });
  assert.deepEqual([old.summary.group, old.summary.label], ["history", LABELS.stopped]);
  // Out of the list, but the thread is kept: the page still says it can be resumed.
  assert.match(old.detail.status.next, /stopped for over an hour\. Ask the agent to resume it/);
});

test("a session in history comes back to In progress when the agent resumes it", () => {
  for (const key of ["noReply", "stoppedOld"]) {
    const dir = path.join(tmp, `resumed-${key}`, ".cross-review", "sessions", path.basename(fx.sessions[key]));
    fs.cpSync(fx.sessions[key], dir, { recursive: true });
    assert.equal(classify(readSession(dir), { now: fx.now, isAlive }).summary.group, "history", key);
    // review_reply: the runner archives the round's files and starts a new round with a live reviewer
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    const rounds = JSON.parse(fs.readFileSync(path.join(dir, "rounds.json"), "utf8"));
    const n = String(rounds.length).padStart(3, "0");
    for (const [live, archived] of [["final.txt", `final-round-${n}.json`], ["output.jsonl", `output-round-${n}.jsonl`], ["review.md", `review-round-${n}.md`]]) {
      if (fs.existsSync(path.join(dir, live))) fs.renameSync(path.join(dir, live), path.join(dir, "outputs", archived));
    }
    rounds.push({ round: rounds.length + 1, status: "running", started_at: fx.now - 30 });
    Object.assign(state, { round: rounds.length, pid: LIVE, thread_id: state.thread_id || "invented-thread" });
    fs.writeFileSync(path.join(dir, "rounds.json"), JSON.stringify(rounds));
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
    const { summary } = classify(readSession(dir), { now: fx.now, isAlive });
    assert.deepEqual([summary.group, summary.label], ["active", LABELS.running], key);
  }
});

test("a running round whose reviewer died unpolled is read from its event log", () => {
  const { summary } = at("deadPid");
  assert.deepEqual([summary.group, summary.state], ["history", "approve"]);
  // The same session with the reviewer alive is running
  const parsed = readSession(fx.sessions.deadPid);
  assert.equal(classify(parsed, { now: fx.now, isAlive: () => true }).summary.state, "running");
});

test("a session finalized by convergence with meta.verdict REVISE is a stalemate", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(fx.sessions.stalemate, "meta.json"), "utf8"));
  assert.equal(meta.verdict, "REVISE");
  const { summary, detail } = at("stalemate");
  assert.equal(summary.state, "stalemate");
  assert.match(detail.status.what, /^Stalemate on ISSUE-3\. You decide\.$/);
});

test("a finalized session with a plain REVISE and no convergence reads as stopped", () => {
  const dir = writeSession(path.join(tmp, "extra", ".cross-review", "sessions"), "review-plan-20261010-001", {
    skill: "review-plan", created: fx.now - 500, meta: "REVISE", state: { ended_at: fx.now - 100 },
    rounds: [{ status: "completed", started: fx.now - 500, elapsed: 60, review: "### ISSUE-1: x\n- Severity: low\n\n### VERDICT\n- Status: REVISE\n" }],
  });
  assert.deepEqual([classify(readSession(dir), { now: fx.now }).summary.state], ["stopped"]);
});

// ---------- 3: titles ----------

test("titles come from each skill's input, cut at 120 characters on a word", () => {
  assert.equal(at("approved").summary.title, "Review phase 2 of `dashboard-plan.md` before moving on.");
  assert.equal(at("warn").summary.title, "search-index-plan.md");
  assert.equal(at("think").summary.title, "Should tags be user-defined?");
  assert.equal(at("pr").summary.title, "Add CSV export");
  assert.equal(at("endedOpen").summary.title, "Retry failed uploads with backoff. The second line is not part of the title.");
  assert.equal(at("missingInput").summary.title, "review-plan-20261012-001");
  const long = "word ".repeat(40).trim();
  const dir = writeSession(path.join(tmp, "extra", ".cross-review", "sessions"), "review-impl-20261010-002", {
    skill: "review-impl", mode: "working-tree", created: fx.now, inputs: [`## USER_REQUEST\n${long}\n`],
    rounds: [{ status: "completed", started: fx.now, elapsed: 1, review: "### VERDICT\n- Status: APPROVE\n" }],
  });
  const t = classify(readSession(dir), { now: fx.now }).summary.title;
  assert.ok(t.endsWith("…") && t.length <= 121 && !t.slice(0, -1).endsWith(" "), t);
  assert.ok(long.startsWith(t.slice(0, -1)));
});

// ---------- 4: the mock's story ----------

test("the approved story: ledger, steps and sentences match the mock", () => {
  const { detail } = at("approved");
  const trails = Object.fromEntries(detail.ledger.map(i => [i.id, i.trail.join("→")]));
  assert.deepEqual(trails, { 1: "raised→fixed→verified", 2: "raised→disputed→withdrawn", 3: "raised→fixed→verified" });
  assert.deepEqual(detail.steps.map(s => [s.strong, s.text].filter(Boolean).join(" ")),
    ["Round 1 2 new", "agent: 1 fixed, 1 disputed", "Round 2 1 new", "agent: 1 fixed", "Round 3 approved"]);
  assert.equal(detail.status.what, "Approved in round 3.");
  assert.equal(detail.status.next, "Three issues: two fixed and confirmed, one withdrawn by the reviewer after the agent disputed it.");
  assert.equal(detail.summary?.issues ?? at("approved").summary.issues, "3: 2 fixed, 1 withdrawn");
  assert.deepEqual(detail.thread.map(m => m.who), ["us", "rv", "ag", "rv", "ag", "rv"]);
  assert.equal(detail.thread[1].issues.length, 2);
  assert.deepEqual(detail.thread[1].issues[0].location, "scripts/lib/config.js:41");
});

test("the running story ends with checking now and Round 3 in progress", () => {
  const { detail, summary } = at("running");
  assert.equal(detail.ledger.find(i => i.id === 3).pending, "checking now");
  assert.equal(detail.ledger.find(i => i.id === 1).pending, null);
  assert.equal(detail.steps.length, 5);
  assert.deepEqual([detail.steps[4].strong, detail.steps[4].text], ["Round 3", "in progress"]);
  assert.equal(detail.status.what, "The reviewer is checking the agent's reply to round 2.");
  assert.match(detail.status.next, /^Round 3, running \{clock\}\./);
  assert.equal(detail.thread.at(-1).kind, "running");
  assert.ok(summary.now && summary.now.length > 0);
  assert.equal(detail.facts.caller.title, "Claude Code");
  // the list shows the effort the review runs at, after its model
  assert.equal(summary.effort, "xhigh");
  // In progress shows what the latest finished review raised, while round 3 runs
  assert.deepEqual(summary.newIssues, { round: 2, count: 1, text: "1 new" });
  assert.equal(summary.issueCount, 3);
});

test("newIssues: what the latest review left open, null before any review and for peer skills", () => {
  assert.deepEqual(at("waiting").summary.newIssues, { round: 2, count: 1, text: "1 new" });
  assert.equal(at("think").summary.newIssues, null);
  const dir = writeSession(path.join(tmp, "extra", ".cross-review", "sessions"), "review-impl-20261010-003", {
    skill: "review-impl", mode: "working-tree", created: fx.now, inputs: ["## USER_REQUEST\nInvented.\n"],
    rounds: [{ status: "running", started: fx.now - 30, elapsed: 0, acts: [] }],
  });
  assert.equal(classify(readSession(dir), { now: fx.now, isAlive: () => true }).summary.newIssues, null);
});

// ---------- issues not closed by a round: still open, maintained, reopened ----------

const issueBlock = (id, title) => `### ISSUE-${id}: ${title}\n- Category: bug\n- Severity: medium\n- Problem: Invented.\n`;
const revise = ids => ids.map(id => issueBlock(id, `Invented defect ${id}`)).join("\n") + "\n### VERDICT\n- Status: REVISE\n- Reason: Invented.\n";
const replyIn = (fixed, disputed = []) => `## FIXED_ITEMS\n${fixed.map(id => `ISSUE-${id}: Invented — fixed in src/a.js:1`).join("\n") || "None"}\n\n## DISPUTED_ITEMS\n${disputed.map(id => `ISSUE-${id}: Invented — not a defect`).join("\n") || "None"}\n`;
function storySession(id, reviews, replies) {
  return writeSession(path.join(tmp, "open-kinds", ".cross-review", "sessions"), id, {
    skill: "review-impl", mode: "working-tree", created: fx.now - 3000,
    inputs: ["## USER_REQUEST\nInvented request.\n", ...replies],
    rounds: reviews.map((ids, i) => ({ status: "completed", started: fx.now - 2000 + i * 100, elapsed: 30, review: revise(ids) })),
  });
}

test("a round that keeps a fixed or disputed issue counts it as still open or maintained, not as nothing new", () => {
  const dir = storySession("review-impl-20261010-101", [[1, 2], [1, 2]], [replyIn([1], [2])]);
  const { summary, detail } = classify(readSession(dir), { now: fx.now, isAlive });
  assert.deepEqual(summary.newIssues, { round: 2, count: 0, text: "1 still open, 1 maintained" });
  assert.deepEqual(detail.ledger.map(i => i.trail.at(-1)), ["still open", "maintained"]);
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "1 still open, 1 maintained");
});

test("an issue raised again after it was closed is reopened, not new", () => {
  const dir = storySession("review-impl-20261010-102", [[1], [2], [1]], [replyIn([1]), replyIn([2])]);
  const { summary, detail } = classify(readSession(dir), { now: fx.now, isAlive });
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "verified", "reopened"]);
  assert.deepEqual(summary.newIssues, { round: 3, count: 0, text: "1 reopened" });
  assert.equal(detail.steps.find(x => x.strong === "Round 3").text, "1 reopened");
  assert.equal(summary.issues, "2: 1 fixed, 1 open");
});

const approveRecap = ids => ids.map(id => issueBlock(id, `Invented defect ${id}`)).join("\n") + "\n### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n";
function storyOf(id, rounds, replies) {
  return writeSession(path.join(tmp, "open-kinds", ".cross-review", "sessions"), id, {
    skill: "review-impl", mode: "working-tree", created: fx.now - 3000,
    inputs: ["## USER_REQUEST\nInvented request.\n", ...replies],
    rounds: rounds.map((review, i) => ({ status: "completed", started: fx.now - 2000 + i * 100, elapsed: 30, review })),
  });
}
const classified = dir => classify(readSession(dir), { now: fx.now, isAlive });

test("an approval that recaps a fixed issue closes it; raising it later is a reopen", () => {
  const { detail } = classified(storyOf("review-impl-20261010-103", [revise([1]), approveRecap([1]), revise([1])], [replyIn([1]), replyIn([])]));
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "verified", "reopened"]);
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "approved");
});

test("a round with neither a verdict nor findings closes nothing", () => {
  const { summary, detail } = classified(storyOf("review-impl-20261010-104", [revise([1]), "I could not finish the review.\n", revise([1])], [replyIn([1]), replyIn([])]));
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "still open"]);
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "no verdict");
  assert.deepEqual(summary.newIssues, { round: 3, count: 0, text: "1 still open" });
});

test("an issue raised again with no fix or dispute on record is open, not maintained", () => {
  const { summary, detail } = classified(storyOf("review-impl-20261010-105", [revise([1]), revise([1])], []));
  assert.deepEqual(summary.newIssues, { round: 2, count: 0, text: "1 open" });
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "1 open");
});

test("a stalemate keeps its label and counts the kept issues as maintained", () => {
  const dir = storyOf("review-impl-20261010-106", [revise([1]), revise([1])], [replyIn([], [1])]);
  const final = path.join(dir, "final.txt");
  fs.writeFileSync(final, JSON.stringify({ ...JSON.parse(fs.readFileSync(final, "utf8")), convergence: { stalemate: true } }));
  const { summary, detail } = classified(dir);
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "stalemate · 1 maintained");
  assert.equal(summary.newIssues.text, "1 maintained");
});

test("a reviewer's own STALEMATE still tells a fix that did not hold from a kept dispute", () => {
  const verdict = ids => revise(ids).replace("Status: REVISE", "Status: STALEMATE");
  const { summary, detail } = classified(storyOf("review-impl-20261010-108", [revise([1, 2]), verdict([1, 2])], [replyIn([1], [2])]));
  assert.equal(detail.steps.find(x => x.strong === "Round 2").text, "stalemate · 1 still open, 1 maintained");
  assert.equal(summary.newIssues.text, "1 still open, 1 maintained");
  // the reviewer's own verdict names no deadlocked set: the banner lists what is still open
  assert.equal(detail.status.what, "Stalemate. Still open: ISSUE-1, ISSUE-2. You decide.");
});

test("a peer session the caller ended as a stalemate does not credit the reviewer with it", () => {
  const dir = writeSession(path.join(tmp, "open-kinds", ".cross-review", "sessions"), "review-pr-20261010-111", {
    skill: "review-pr", created: fx.now - 3000, inputs: ["## PR_TITLE\nInvented PR.\n"], meta: "STALEMATE",
    rounds: [{ status: "completed", started: fx.now - 2000, elapsed: 30, review: "### Position\n- Invented.\n\n### VERDICT\n- Status: CONTINUE\n" }],
  });
  const { summary, detail } = classified(dir);
  assert.equal(summary.state, "stalemate");
  assert.equal(detail.status.next, "See the last exchange for context.");
});

test("DONE in a review session closes nothing: the listed issue is still open", () => {
  const done = ids => revise(ids).replace("Status: REVISE", "Status: DONE");
  const { summary, detail } = classified(storyOf("review-impl-20261010-109", [revise([1]), done([1])], [replyIn([1])]));
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "still open"]);
  assert.equal(summary.newIssues.text, "1 still open");
});

test("a heading repeated in one message is one issue with one outcome", () => {
  const twice = id => issueBlock(id, "Invented defect") + "\n" + issueBlock(id, "Invented defect, again") + "\n### VERDICT\n- Status: REVISE\n- Reason: Invented.\n";
  const { summary, detail } = classified(storyOf("review-impl-20261010-110", [twice(1), twice(1)], [replyIn([1])]));
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "still open"]);
  assert.equal(summary.newIssues.text, "1 still open");
});

test("an issue both fixed and disputed in one reply counts as fixed", () => {
  const { summary, detail } = classified(storyOf("review-impl-20261010-107", [revise([1]), revise([1])], [replyIn([1], [1])]));
  assert.deepEqual(detail.ledger.find(i => i.id === 1).trail, ["raised", "fixed", "still open"]);
  assert.equal(summary.newIssues.text, "1 still open");
});

test("waiting, stopped and peer stories say what the mock says", () => {
  const w = at("waiting").detail;
  assert.equal(w.status.what, "Round 2 left one issue open. The agent has to fix or dispute it.");
  assert.match(w.status.next, /^ISSUE-3 came from the round-1 fix\. Waiting \d+ min\.$/);
  assert.equal(w.ledger.find(i => i.id === 3).pending, "agent's turn");
  assert.equal(at("waiting").summary.now, TEXT.nowWaiting);
  assert.equal(at("pr").summary.now, TEXT.nowWaitingPeer);

  const s = at("stopped").detail;
  assert.equal(s.status.what, "Stopped in round 3: You've hit your usage limit. Try again at 15:40.");
  assert.match(s.status.next, /^The reviewer's thread is kept\./);
  assert.equal(s.ledger.find(i => i.id === 3).pending, "not checked");

  const t = at("think").detail;
  assert.deepEqual(t.thread.map(m => `${m.who}:${m.kind}`), ["us:ask", "rv:review", "ag:analysis", "ag:reply", "rv:review"]);
  assert.ok(t.thread[1].rawMd.includes("### Position"));
  assert.deepEqual(t.thread[3].reply.sections.map(x => x.name), ["Agreed", "Disagreed", "New"]);
  assert.equal(t.ledger.length, 0);
  assert.equal(at("think").summary.issues, "—");
});

test("maintained and still open need the agent's earlier word, not just presence", () => {
  const sessions = path.join(tmp, "ledger", ".cross-review", "sessions");
  const two = "### ISSUE-1: a\n- Severity: high\n\n### ISSUE-2: b\n- Severity: low\n\n### VERDICT\n- Status: REVISE\n";
  const base = { skill: "review-plan", created: fx.now - 900, inputs: [
    "PLAN_PATH: /x/p-plan.md\n",
    "PLAN_PATH: /x/p-plan.md\n## FIXED_ITEMS\nISSUE-1: a — fixed in p.md:3\n\n## DISPUTED_ITEMS\nISSUE-2: b — not a defect\n",
  ] };
  const dir = writeSession(sessions, "review-plan-20261011-001", { ...base, rounds: [
    { status: "completed", started: fx.now - 900, elapsed: 10, review: two },
    { status: "completed", started: fx.now - 800, elapsed: 10, review: two },
  ] });
  const trails = Object.fromEntries(classify(readSession(dir), { now: fx.now }).detail.ledger.map(i => [i.id, i.trail.join("→")]));
  assert.deepEqual(trails, { 1: "raised→fixed→still open", 2: "raised→disputed→maintained" });
});

// ---------- 5: agent replies ----------

test("parseAgentReply reads ids, text and file:line; None means nothing", () => {
  assert.deepEqual(parseAgentReply("ISSUE-1: Title — fixed in scripts/lib/config.js:41, test tests/a.test.js:22\nISSUE-12: other — no location"), [
    { id: 1, text: "Title — fixed in scripts/lib/config.js:41, test tests/a.test.js:22", location: "scripts/lib/config.js:41" },
    { id: 12, text: "other — no location", location: null },
  ]);
  assert.deepEqual(parseAgentReply("None — all issues addressed"), []);
  assert.deepEqual(parseAgentReply("- ISSUE-3 maintained, see `a/b.js:10-12`"), [{ id: 3, text: "maintained, see `a/b.js:10-12`", location: "a/b.js:10-12" }]);
});

// ---------- 6: humanize ----------

test("humanize names each kind of command, wrapped or chained", () => {
  const h = (command, extra = {}) => humanize({ kind: "command", command, exitCode: 0, status: "completed", ...extra });
  const cases = [
    ["/bin/zsh -lc \"sed -n '41,80p' scripts/lib/config.js\"", "read", "scripts/lib/config.js:41-80"],
    ["bash -lc 'cat tests/config.test.js'", "read", "tests/config.test.js"],
    ["/bin/zsh -lc \"nl -ba src/a.js | sed -n '5,9p'\"", "read", "src/a.js:5-9"],
    ["head -n 40 README.md", "read", "README.md"],
    ["/bin/zsh -lc \"rg -n 'mergeLevel' scripts tests\"", "search", "mergeLevel"],
    ["git grep -n loadConfig", "search", "loadConfig"],
    ["/bin/zsh -lc 'cd sub && npm test'", "test", "npm test"],
    ["/bin/zsh -lc 'node --test tests/config.test.js'", "test", "node --test tests/config.test.js"],
    ["/bin/zsh -lc 'git diff a91c2e0...HEAD -- scripts/lib/config.js'", "diff", "a91c2e0...HEAD -- scripts/lib/config.js"],
    ["/bin/zsh -lc 'd=$(mktemp -d) && cd \"$d\" && git init'", "scratch", null],
    ["/bin/zsh -lc 'ls -la && pwd'", "run", "ls -la && pwd"],
  ];
  for (const [cmd, kind, what] of cases) {
    const r = h(cmd);
    assert.equal(r.kind, kind, cmd);
    if (what !== null) assert.equal(r.what, what, cmd);
    assert.equal(r.raw, cmd);
  }
  assert.equal(h("npm test", { exitCode: 1, status: "failed" }).text, "Ran tests: npm test — failed (exit 1)");
  assert.equal(h("npm test").text, "Ran tests: npm test — passed");
  assert.equal(h("npm test", { exitCode: null, status: "in_progress" }).result, "running");
  assert.equal(humanize({ kind: "reasoning", text: "  checking\nthe order " }).text, "Thinking: checking the order");
  assert.equal(humanize({ kind: "tool", tool: "ctxe.semantic_search" }).kind, "tool");
  assert.equal(humanize({ kind: "file_change", path: "a.js" }).kind, "change");
  assert.equal(unwrapShell("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
});

test("consecutive reads fold into one line; read, search, read does not", () => {
  const k = kinds => groupReads(kinds.map(kind => ({ kind }))).map(g => `${g.kind}${g.items.length}`);
  assert.deepEqual(k(["read", "read", "read"]), ["read3"]);
  assert.deepEqual(k(["read", "search", "read"]), ["read1", "search1", "read1"]);
});

// ---------- 7: times ----------

test("attachTimes gives each item the time of the first row covering its first line", () => {
  const items = [{ line: 0 }, { line: 1 }, { line: 4 }, { line: 9 }];
  const rows = [[2, 1010], [5, 1013]];
  assert.deepEqual(attachTimes(items, rows, 1000).map(i => i.t), [10, 10, 13, null]);
  assert.deepEqual(attachTimes(items, [], 1000).map(i => i.t), [null, null, null, null]);
});

// ---------- 8, 9, 10: Codex activity items ----------

function eventsFromFixture() {
  return fs.readFileSync(path.join(fx.sessions.approved, "outputs", "output-round-001.jsonl"), "utf8").split("\n").slice(0, -1);
}

test("activityItems gives one item per item id, without the turn's final message", () => {
  const lines = eventsFromFixture();
  const ids = new Set(lines.map(l => JSON.parse(l)).filter(e => e.item).map(e => e.item.id));
  const items = activityItems(lines);
  assert.equal(items.length, ids.size - 1);
  assert.ok(!items.some(i => i.kind === "message" && /VERDICT/.test(i.text)));
  assert.deepEqual(items.map(i => i.line), [...items.map(i => i.line)].sort((a, b) => a - b));
});

test("completion-only items keep their own line and time", () => {
  const ev = [
    { type: "turn.started" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", status: "in_progress", exit_code: null } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", status: "completed", exit_code: 0 } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "interim note" } },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
    { type: "item.started", item: { id: "c2", type: "command_execution", command: "pwd", status: "in_progress", exit_code: null } },
  ].map(e => JSON.stringify(e));
  const items = activityItems(ev);
  assert.deepEqual(items.map(i => [i.id, i.line]), [["c1", 1], ["m1", 3], ["r1", 4], ["c2", 5]]);
  const timed = attachTimes(items, [[2, 100], [4, 104], [6, 106]], 90);
  assert.deepEqual(timed.map(i => i.t), [10, 14, 16, 16]);
});

test("a command keeps its identity and line from started to completed", () => {
  const started = [
    { type: "item.started", item: { id: "a", type: "command_execution", command: "npm test", status: "in_progress", exit_code: null } },
    { type: "item.started", item: { id: "b", type: "command_execution", command: "npm test", status: "in_progress", exit_code: null } },
  ].map(e => JSON.stringify(e));
  const first = activityItems(started);
  const done = activityItems([...started,
    JSON.stringify({ type: "item.completed", item: { id: "a", type: "command_execution", command: "npm test", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { id: "b", type: "command_execution", command: "npm test", status: "failed", exit_code: 1 } }),
  ]);
  assert.equal(first.length, 2);
  assert.equal(done.length, 2);
  assert.deepEqual(done.map(i => i.line), first.map(i => i.line));
  assert.deepEqual(done.map(i => [i.exitCode, i.status]), [[0, "completed"], [1, "failed"]]);
  assert.deepEqual(done.map(i => i.lastLine), [2, 3]);
  assert.equal(humanize(done[1]).text, "Ran tests: npm test — failed (exit 1)");
});

test("readSession keys activity by round and item id and stamps times", () => {
  const parsed = readSession(fx.sessions.running);
  const live = parsed.rounds.at(-1);
  assert.equal(live.items.length, 45);
  assert.ok(live.items.every(i => i.key === `3:${i.id}` && typeof i.t === "number"));
  assert.equal(new Set(live.items.map(i => i.key)).size, 45);
});

// ---------- checkpoint review (review-impl-20261015-012) regressions ----------

test("a failed round nobody polled keeps the thread from its event log, so it stays resumable", () => {
  const now = 1_800_000_000;
  const dir = writeSession(path.join(tmp, "unpolled-failed", ".cross-review", "sessions"), "review-impl-20261015-090", {
    skill: "review-impl", created: now - 50, threadId: null, inputs: ["## USER_REQUEST\nInvented task.\n"],
    rounds: [{ status: "running", started: now - 50, elapsed: 0, acts: [] }],
  });
  // the log has the thread, then the turn fails; state.json never got the thread id
  fs.writeFileSync(path.join(dir, "output.jsonl"), [
    { type: "thread.started", thread_id: "thread-invented-failed" },
    { type: "turn.started" },
    { type: "turn.failed", error: { message: "Invented transient error." } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const { summary } = classify(readSession(dir), { now, isAlive: () => false });
  assert.equal(summary.state, "stopped");
  assert.equal(summary.group, "active");
  assert.equal(summary.label, LABELS.resumable);
});

test("a completed round nobody polled gets the runner's convergence: same open issues twice is a stalemate", () => {
  const now = 1_800_000_000;
  const review = "### ISSUE-1: Invented unresolved issue\n- Severity: medium\n- Problem: Invented problem.\n\n### VERDICT\n- Status: REVISE\n- Reason: Still open.\n";
  const dir = writeSession(path.join(tmp, "unpolled-converged", ".cross-review", "sessions"), "review-impl-20261015-091", {
    skill: "review-impl", created: now - 100, inputs: ["## USER_REQUEST\nInvented task.\n", "## DISPUTED_ITEMS\nISSUE-1: Disputed.\n"],
    rounds: [
      { status: "completed", started: now - 100, elapsed: 10, review },
      { status: "running", started: now - 40, elapsed: 0, acts: [] },
    ],
  });
  fs.appendFileSync(path.join(dir, "output.jsonl"), [
    { type: "item.completed", item: { id: "final-review", type: "agent_message", text: review } },
    { type: "turn.completed" },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const { summary } = classify(readSession(dir), { now, isAlive: () => false });
  assert.equal(summary.group, "history");
  assert.equal(summary.state, "stalemate");
});

test("inputValues splits only on the skill's placeholders; other uppercase headings stay in the value", () => {
  const raw = "## USER_REQUEST\nReview this invented requirement.\n\n## API\nThe invented export must include all columns.\n\n## SESSION_CONTEXT\nInvented context.\n";
  const v = inputValues(raw, "review-impl");
  assert.equal(v.USER_REQUEST, "Review this invented requirement.\n\n## API\nThe invented export must include all columns.");
  assert.equal(v.SESSION_CONTEXT, "Invented context.");
  assert.equal(v.API, undefined);
  const reply = inputValues("## FIXED_ITEMS\nISSUE-1: fixed.\n\n## NOTES\nkept\n\n## DISPUTED_ITEMS\nNone\n", "review-plan");
  assert.match(reply.FIXED_ITEMS, /## NOTES\nkept/);
  assert.equal(reply.DISPUTED_ITEMS, "None");
});

test("each session's inputs split on the placeholders of its own prompts directory (state.skills_dir)", () => {
  const now = 1_800_000_000;
  const custom = path.join(tmp, "custom-skills");
  fs.mkdirSync(path.join(custom, "review-impl", "references"), { recursive: true });
  const original = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../skill-packs/cross-review/skills/review-impl/references/prompts.md"), "utf8");
  fs.writeFileSync(path.join(custom, "review-impl", "references", "prompts.md"), original + "\nInvented custom context: {API}\n");
  const raw = "## USER_REQUEST\nInvented request.\n\n## API\nInvented separate parameter.\n\n## SESSION_CONTEXT\nInvented context.\n";
  const approve = "### VERDICT\n- Status: APPROVE\n- Reason: Invented approval.\n";
  const sess = path.join(tmp, "two-dirs", ".cross-review", "sessions");
  const ask = (id, state) => {
    const dir = writeSession(sess, id, { skill: "review-impl", created: now, state, inputs: [raw], meta: "APPROVE", rounds: [{ status: "completed", started: now, elapsed: 1, review: approve }] });
    return classify(readSession(dir), { now: now + 10 }).detail.thread.find(x => x.kind === "ask").md;
  };
  assert.equal(ask("review-impl-20261015-095", { skills_dir: custom }), "Invented request.");
  assert.equal(ask("review-impl-20261015-096", {}), "Invented request.\n\n## API\nInvented separate parameter.");
  assert.equal(inputValues(raw, "review-impl", custom).API, "Invented separate parameter.");
});

// ---------- the ended-session reader of the History archive ----------

test("readSession logs:false reads no event log or line times and gives the same archive fields", () => {
  const ARCHIVED = ["id", "skill", "title", "state", "rounds", "issues", "issueCount", "model", "effort", "reviewer", "reviewerSeconds", "createdAt"];
  const pick = s => Object.fromEntries(ARCHIVED.map(k => [k, s[k]]));
  const isLog = f => /output(-round-\d+)?\.jsonl$|times-round-\d+\.jsonl$/.test(String(f));
  const count = fn => {
    const realOpen = fs.openSync;
    const realRead = fs.readFileSync;
    let n = 0;
    fs.openSync = function (f, ...rest) {
      if (isLog(f)) n++;
      return realOpen.call(this, f, ...rest);
    };
    fs.readFileSync = function (f, ...rest) {
      if (isLog(f)) n++;
      return realRead.call(this, f, ...rest);
    };
    try {
      return { out: fn(), n };
    } finally {
      fs.openSync = realOpen;
      fs.readFileSync = realRead;
    }
  };
  // an ended session at a non-default effort, so a reader that falls back to the default fails
  const lowDir = writeSession(path.join(tmp, "low-effort", ".cross-review", "sessions"), "review-impl-20261010-201", {
    skill: "review-impl", mode: "working-tree", created: fx.now - 900, meta: "APPROVE", inputs: ["## USER_REQUEST\nInvented.\n"],
    state: { effort: "low", ended_at: fx.now - 100 },
    rounds: [{ status: "completed", started: fx.now - 800, elapsed: 30, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n", acts: [] }],
  });
  assert.equal(classify(readSession(lowDir, { logs: false }), { now: fx.now, isAlive }).summary.effort, "low");
  // the effort the runner passed wins over the one asked for; null when none was passed (an agy variant)
  const appliedDir = writeSession(path.join(tmp, "low-effort", ".cross-review", "sessions"), "review-impl-20261010-202", {
    skill: "review-impl", mode: "working-tree", reviewer: "agy", created: fx.now - 900, meta: "APPROVE", inputs: ["## USER_REQUEST\nInvented.\n"],
    state: { model: "gemini-x-flash-low", effort: "high", effort_applied: null, ended_at: fx.now - 100 },
    rounds: [{ status: "completed", started: fx.now - 800, elapsed: 30, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n", acts: [] }],
  });
  const applied = classify(readSession(appliedDir, { logs: false }), { now: fx.now, isAlive });
  assert.equal(applied.summary.effort, null);
  assert.equal(applied.detail.facts.effort, null);
  for (const key of ["approved", "stalemate", "think", "endedOpen", "stoppedOld"]) {
    const dir = fx.sessions[key];
    const full = count(() => readSession(dir));
    const light = count(() => readSession(dir, { logs: false }));
    assert.ok(full.n > 0, `${key}: the default reader is the positive control`);
    assert.equal(light.n, 0, `${key}: logs:false opened ${light.n} log files`);
    assert.deepEqual(pick(classify(light.out, { now: fx.now, isAlive }).summary), pick(classify(full.out, { now: fx.now, isAlive }).summary), key);
  }
});

// ---------- review checkpoint: incremental log reads (D5) ----------

test("readSession reads only the bytes appended to output.jsonl since the last read; a replaced log is read again", () => {
  const dir = fx.sessions.running;
  const log = path.join(dir, "output.jsonl");
  const original = fs.readFileSync(log);
  const big = JSON.stringify({ type: "item.completed", item: { id: "big-out", type: "command_execution", command: "node --test", status: "completed", exit_code: 0, aggregated_output: "x".repeat(2 * 1024 * 1024) } }) + "\n";
  fs.appendFileSync(log, big);
  try {
    readSession(dir);
    const realReadFileSync = fs.readFileSync;
    const realReadSync = fs.readSync;
    let bytes = 0;
    fs.readFileSync = function (file, ...rest) {
      const out = realReadFileSync.call(this, file, ...rest);
      if (String(file).endsWith(".jsonl") && String(file).includes("output")) bytes += Buffer.byteLength(out);
      return out;
    };
    fs.readSync = function (...args) {
      const n = realReadSync.apply(this, args);
      bytes += n;
      return n;
    };
    let s;
    try {
      fs.appendFileSync(log, JSON.stringify({ type: "item.completed", item: { id: "tail-r", type: "reasoning", text: "Checking an invented branch." } }) + "\n");
      // half a line: not an item yet
      fs.appendFileSync(log, '{"type":"item.completed","item":{"id":"half"');
      s = readSession(dir);
    } finally {
      fs.readFileSync = realReadFileSync;
      fs.readSync = realReadSync;
    }
    assert.ok(bytes < 64 * 1024, `read ${bytes} bytes for a ~150-byte append`);
    const live = s.rounds[s.rounds.length - 1].items;
    assert.ok(live.some(i => i.id === "big-out") && live.some(i => i.id === "tail-r"));
    assert.ok(!live.some(i => i.id === "half"));
    fs.appendFileSync(log, ',"type":"reasoning","text":"Now complete."}}\n');
    assert.ok(readSession(dir).rounds.at(-1).items.some(i => i.id === "half" && /Now complete\./.test(i.text)), "the split line completes");

    // replaced by a shorter file: read from the start, old items gone
    fs.rmSync(log);
    fs.writeFileSync(log, JSON.stringify({ type: "item.completed", item: { id: "fresh", type: "reasoning", text: "A new log." } }) + "\n");
    const ids = readSession(dir).rounds.at(-1).items.map(i => i.id);
    assert.deepEqual(ids, ["fresh"]);
  } finally {
    fs.writeFileSync(log, original);
  }
  // back to the fixture: same items as a fresh parse
  const lines = fs.readFileSync(log, "utf8").split("\n").slice(0, -1);
  assert.deepEqual(readSession(dir).rounds.at(-1).items.map(i => i.id), activityItems(lines).map(i => i.id));
});

test("a resumed round that rewrites output.jsonl in place with the same first bytes is read as the new round", () => {
  const dir = path.join(tmp, "resume-ws", ".cross-review", "sessions", "review-impl-20261015-301");
  fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
  const line = v => `${JSON.stringify(v)}\n`;
  const prefix = line({ type: "thread.started", thread_id: "invented-thread" }) + line({ type: "turn.started" })
    + line({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "git status --short", status: "completed", exit_code: 0, aggregated_output: "Invented status. ".repeat(20) } });
  const r1 = prefix + line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n" } }) + line({ type: "turn.completed" });
  const log = path.join(dir, "output.jsonl");
  const state = { skill_name: "review-impl", reviewer: "codex", mode: "branch", round: 1, created_at: 100, thread_id: "invented-thread" };
  const rounds = [{ round: 1, status: "running", started_at: 100 }];
  const save = () => {
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(dir, "rounds.json"), JSON.stringify(rounds));
  };
  fs.writeFileSync(log, r1);
  save();
  assert.equal(readSession(dir).rounds[0].outcome.turnCompleted, true);
  // round 2 resumes the same thread into the same file: same first bytes, longer, not finished
  fs.copyFileSync(log, path.join(dir, "outputs", "output-round-001.jsonl"));
  state.round = 2;
  rounds[0].status = "completed";
  rounds.push({ round: 2, status: "running", started_at: 201 });
  save();
  fs.writeFileSync(log, prefix + line({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "Invented new round. ".repeat(100) } }));
  const live = readSession(dir).rounds.at(-1);
  assert.equal(live.round, 2);
  assert.equal(live.outcome.turnCompleted, false);
  assert.deepEqual(live.items.map(i => [i.id, i.kind]), [["item_0", "run"], ["item_1", "think"]]);
});
