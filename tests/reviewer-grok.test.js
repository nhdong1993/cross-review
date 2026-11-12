import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as claude from "../skill-packs/cross-review/scripts/lib/reviewers/claude.js";
import * as grok from "../skill-packs/cross-review/scripts/lib/reviewers/grok.js";
import { getReviewer, REVIEWER_NAMES } from "../skill-packs/cross-review/scripts/lib/reviewers/index.js";
import { writeFakeGrok } from "./helpers/fake-grok.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "helpers", "fixtures", "grok-turn.jsonl");
const lines = () => fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const j = e => JSON.stringify(e);
const SID = "01a1d000-0000-7000-8000-0000000097c0";
const CANCELLED = j({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"], session_id: "s1" });

const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME };
let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-grok-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.mkdirSync(path.join(tmp, "grok-home"));
  writeFakeGrok(path.join(tmp, "bin"));
  process.env.PATH = `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`;
  process.env.GROK_HOME = path.join(tmp, "grok-home");
  fs.writeFileSync(path.join(tmp, "system.md"), "# Reviewer \"rules\"\nBe strict.\n");
});

after(() => {
  process.env.PATH = saved.PATH;
  if (saved.GROK_HOME === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = saved.GROK_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Runs fn as if on another platform. */
function onPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

test("grok is a registered reviewer: any model name, efforts depend on the model", () => {
  assert.ok(REVIEWER_NAMES.includes("grok"));
  const r = getReviewer("grok");
  assert.deepEqual([r.label, r.efforts, r.allowCustomModel, r.checkSelection, r.encodePrompt], ["Grok Build", null, true, undefined, undefined]);
  assert.deepEqual([r.sandboxes, r.defaultSandbox, r.fullAccessSandbox], [["read-only", "danger-full-access"], "read-only", "danger-full-access"]);
});

test("buildCommand: fixed flags first, then the variable values, the system prompt last", () => {
  const fixed = ["--output-format", "streaming-messages-json", "--verbatim", "--no-auto-update", "--no-plan"];
  const full = ["--sandbox", "off", "--always-approve"];
  assert.deepEqual(
    grok.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "danger-full-access", promptFile: "/s/prompt.txt" }),
    { cmd: "grok", args: [...fixed, ...full, "--prompt-file", "/s/prompt.txt", "--effort", "high"], cwd: "/w" },
  );
  assert.deepEqual(
    onPlatform("darwin", () => grok.buildCommand({ threadId: "", workingDir: "/w", model: "grok-x", effort: "low", sandbox: "read-only", promptFile: "/s/prompt.txt" }).args),
    [...fixed, "--sandbox", "read-only", "--always-approve", "--prompt-file", "/s/prompt.txt", "-m", "grok-x", "--effort", "low"],
  );
  // a resumed turn names the same sandbox again and passes the system prompt again
  const resumed = grok.buildCommand({
    threadId: "sid-9", workingDir: "/w", model: "grok-x", effort: "xhigh", sandbox: "danger-full-access",
    promptFile: "/s/prompt.txt", systemPromptFile: path.join(tmp, "system.md"),
  }).args;
  assert.deepEqual(resumed, [
    ...fixed, ...full, "--prompt-file", "/s/prompt.txt", "-m", "grok-x", "--effort", "xhigh", "--resume", "sid-9",
    "--system-prompt-override=# Reviewer \"rules\"\nBe strict.\n",
  ]);
  const bare = grok.buildCommand({ threadId: "", workingDir: "/w", model: undefined, effort: undefined, sandbox: "danger-full-access", promptFile: "/p" }).args;
  assert.ok(!bare.includes("-m") && !bare.includes("--effort") && !bare.includes("--resume"));
});

test("buildCommand on Windows: no read-only sandbox, no system prompt past the command-line limit", () => {
  onPlatform("win32", () => {
    assert.throws(
      () => grok.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "read-only", promptFile: "/p" }),
      /read-only sandbox needs macOS or Linux/,
    );
    const big = path.join(tmp, "big.md");
    fs.writeFileSync(big, "x".repeat(33000));
    assert.throws(
      () => grok.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "danger-full-access", promptFile: "/p", systemPromptFile: big }),
      /Windows.*32,767/,
    );
    // a short system prompt fits
    const ok = grok.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "danger-full-access", promptFile: "/p", systemPromptFile: path.join(tmp, "system.md") });
    assert.match(ok.args.at(-1), /^--system-prompt-override=# Reviewer/);
  });
});

test("parseEvents: a recorded turn gives the session id, the review and its activities", () => {
  const all = lines();
  const ev = grok.parseEvents(all, all, 12);
  assert.deepEqual([ev.turnCompleted, ev.turnFailed, ev.threadId, ev.progressObserved, ev.cancelled], [true, false, SID, true, false]);
  assert.match(ev.reviewText, /^### ISSUE-1: Notes lose the second word/);
  assert.deepEqual(ev.activities.map(a => [a.type, a.detail]), [
    ["command_started", "git log --oneline -1"],
    ["command_completed", "git log --oneline -1"],
    ["file_change", "notes.txt (search_replace)"],
    ["file_change", "extra.txt (write)"],
    ["command_started", "false"],
    ["command_completed", "false"],
  ]);
  assert.deepEqual(grok.parseEvents(all, all.slice(9), 30).activities.map(a => [a.type, a.detail]), [["command_started", "false"], ["command_completed", "false"]]);
});

test("activityItems: Grok's tool names, exit codes from the result's JSON, the review left out", () => {
  const items = grok.activityItems(lines());
  assert.deepEqual(items.map(i => [i.kind, i.line]), [["command", 1], ["tool", 3], ["file_change", 5], ["file_change", 7], ["command", 9]]);
  const [log, read, edit, write, fails] = items;
  assert.deepEqual([log.command, log.status, log.exitCode], ["git log --oneline -1", "completed", 0]);
  assert.deepEqual([read.tool, read.text, read.status], ["read_file", "notes.txt", "completed"]);
  assert.deepEqual([edit.path, write.path], ["notes.txt", "extra.txt"]);
  // Grok reports a failed command with is_error false; the code is in the result's JSON
  assert.deepEqual([fails.command, fails.exitCode], ["false", 1]);
  assert.ok(!items.some(i => /VERDICT/.test(i.text || "")));
});

test("the incremental fold equals the one-shot fold", () => {
  const all = lines();
  const s = grok.newLogState();
  for (const l of all) grok.foldLog(s, [l]);
  assert.deepEqual(grok.logItems(s), grok.activityItems(all));
  assert.deepEqual(grok.logOutcome(s), {
    turnCompleted: true, turnFailed: false, failMessage: "",
    reviewText: grok.parseEvents(all, [], 0).reviewText, threadId: SID,
  });
});

test("an error result fails the turn with Grok's message; a cancelled one is marked", () => {
  const init = j({ type: "system", subtype: "init", session_id: "s1" });
  const bad = j({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, errors: ["--effort/--reasoning-effort: unknown effort level 'max'; use one of: low, medium, high, xhigh"], session_id: "s1" });
  const failed = grok.parseEvents([init, bad], [], 1);
  assert.deepEqual([failed.turnFailed, failed.cancelled, failed.threadId], [true, false, "s1"]);
  assert.match(failed.failMessage, /unknown effort level 'max'/);
  const hang = [
    init,
    j({ type: "assistant", message: { id: "msg_0", content: [{ type: "tool_use", id: "c1", name: "run_terminal_command", input: { command: "sleep 97" } }] }, session_id: "s1" }),
    j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "tool call did not complete", is_error: true }] }, session_id: "s1" }),
    CANCELLED,
  ];
  const cancelled = grok.parseEvents(hang, [], 1);
  assert.deepEqual([cancelled.turnFailed, cancelled.cancelled, cancelled.failMessage, cancelled.progressObserved], [true, true, "cancelled", true]);
  // a result that is not JSON: failed when is_error, like any other tool
  assert.deepEqual(grok.activityItems(hang).map(i => [i.command, i.status, i.exitCode]), [["sleep 97", "failed", 1]]);
});

test("Claude Code logs read as before: Grok's names mean nothing there", () => {
  const asClaude = claude.activityItems(lines());
  assert.ok(asClaude.every(i => i.kind === "tool"), "without the Grok dialect every call is a plain tool");
  assert.equal(claude.parseEvents([CANCELLED], [], 1).cancelled, true);
});

test("matchesCmdline: only headless Grok turns, whatever the paths contain", () => {
  const turn = grok.buildCommand({ threadId: "sid-9", workingDir: "/w", model: "grok-x", effort: "high", sandbox: "danger-full-access", promptFile: "/w/.cross-review/sessions/s/prompt.txt", systemPromptFile: path.join(tmp, "system.md") });
  // ps prints the arguments joined by spaces, without quoting
  const asPs = args => ["/Users/x/.grok/bin/grok", ...args].join(" ");
  assert.equal(grok.matchesCmdline(asPs(turn.args)), true);
  const quoted = grok.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "danger-full-access", promptFile: "/tmp/odd\"name/.cross-review/sessions/s/prompt.txt", systemPromptFile: path.join(tmp, "system.md") });
  assert.equal(grok.matchesCmdline(asPs(quoted.args)), true, "an unmatched quote in the session path hides nothing the check needs");
  for (const yes of [
    "grok --output-format streaming-messages-json --verbatim --prompt-file /s/prompt.txt",
    "C:\\tools\\grok.exe --output-format streaming-messages-json --prompt-file C:\\s\\prompt.txt",
  ]) assert.equal(grok.matchesCmdline(yes), true, yes);
  for (const no of [
    "grok",
    "grok models",
    "grok --resume abc",
    "grok --output-format json --prompt-file /s/prompt.txt",
    "grok --output-format streaming-messages-json -p hello",
    "claude -p --output-format stream-json --verbose",
    "grok-helper --output-format streaming-messages-json --prompt-file /s/prompt.txt",
    "vim grok.md --output-format streaming-messages-json --prompt-file x",
  ]) assert.equal(grok.matchesCmdline(no), false, no);
});

test("listModels: the ids `grok models` prints, with the effort levels Grok cached", async () => {
  const cache = path.join(tmp, "grok-home", "models_cache.json");
  // no cache: the levels are unknown
  // every name whole: without the list marker and "(default)", with its spaces (a custom model's)
  assert.deepEqual(await grok.listModels(), ["grok-x-large", "grok-x-small", "grok-x-solo", "local model"].map(slug => ({ slug, name: slug, description: "", efforts: null })));
  fs.writeFileSync(cache, JSON.stringify({
    models: {
      "grok-x-large": { info: { reasoning_efforts: [{ value: "low" }, { value: "high" }, { id: "broken" }] }, api_key: { secret: "never-read" } },
      "grok-x-solo": { info: {} },
    },
  }));
  const models = await grok.listModels();
  assert.deepEqual(models.map(m => [m.slug, m.efforts]), [["grok-x-large", ["low", "high"]], ["grok-x-small", null], ["grok-x-solo", []], ["local model", null]]);
  assert.ok(!JSON.stringify(models).includes("never-read"));
  fs.writeFileSync(cache, "{ broken");
  assert.deepEqual((await grok.listModels()).map(m => m.efforts), [null, null, null, null]);
  fs.rmSync(cache);
  process.env.FAKE_GROK_MODELS_FAIL = "1";
  try {
    await assert.rejects(grok.listModels(), /grok models/);
  } finally {
    delete process.env.FAKE_GROK_MODELS_FAIL;
  }
});

test("listModels: `(default)` is the marker of the starred row only; elsewhere it is part of the name", async () => {
  // real output for a custom model named "local (default)", not the default and then the default
  const list = async rows => {
    process.env.FAKE_GROK_MODELS_TEXT = ["Default model: x", "", "Available models:", ...rows, ""].join("\n");
    try {
      return (await grok.listModels()).map(m => m.slug);
    } finally {
      delete process.env.FAKE_GROK_MODELS_TEXT;
    }
  };
  assert.deepEqual(await list(["  - grok-4.6", "  * grok-4.5 (default)", "  - local (default)"]), ["grok-4.6", "grok-4.5", "local (default)"]);
  assert.deepEqual(await list(["  - grok-4.6", "  - grok-4.5", "  * local (default) (default)"]), ["grok-4.6", "grok-4.5", "local (default)"]);
});

test("no default model is named: Grok's config is TOML, which the runner cannot read reliably", () => {
  fs.writeFileSync(path.join(tmp, "grok-home", "config.toml"), "[models]\ndefault = \"grok-4.5\"\n");
  assert.equal(grok.defaultModel, undefined);
  fs.rmSync(path.join(tmp, "grok-home", "config.toml"));
});

test("cliInfo: the version, and no login check", async () => {
  assert.deepEqual(await grok.cliInfo(), { version: "grok 9.9.9 (invented) [stable]", loggedIn: null });
});
