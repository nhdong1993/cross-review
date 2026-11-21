// Grok Build CLI (xAI) as the reviewer: headless `grok --prompt-file` (it does not read a prompt
// from stdin) with the event log on stdout. `--output-format streaming-messages-json` has the shape
// of Claude Code's stream-json, so claude.js reads it, given Grok's tool names. A turn is resumed
// by its session id. Grok checks the model and the effort itself: an unknown one ends the turn with
// `is_error` and a message naming the valid values, and a model without effort levels ignores the
// effort. Sign-in is Grok's own (`XAI_API_KEY` in the environment of the process that starts the
// review, or `grok login`).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable, programOf, resolveSpawn } from "../command.js";
import * as claude from "./claude.js";

export const name = "grok";
export const label = "Grok Build";
export const installHint = "curl -fsSL https://x.ai/cli/install.sh | bash";

// Same names as Codex's, so review-core can ask any reviewer for full access.
// read-only is Grok's kernel sandbox (macOS and Linux; best effort: Grok warns and goes on when it
// cannot apply it); full access turns the sandbox off, whatever profile the user's config sets.
export const sandboxes = ["read-only", "danger-full-access"];
export const defaultSandbox = "read-only";
export const fullAccessSandbox = "danger-full-access";

// The levels depend on the model (listModels gives them where Grok has cached them)
export const efforts = null;
// `grok models` leaves out hidden models that -m still selects
export const allowCustomModel = true;

export function isAvailable() {
  return commandAvailable("grok");
}

// CreateProcess takes at most 32,767 characters
const WINDOWS_COMMAND_LINE_MAX = 32767;
/** An estimate of the Windows command line: every argument quoted, its quotes escaped. */
const windowsLength = argv => argv.reduce((n, a) => n + a.length + 3 + (a.match(/"/g) || []).length, 0);

/**
 * Command for one turn: threadId empty → new session; otherwise resume that session. Every fixed
 * flag comes before every variable value: the runner recognises the process from `ps` output,
 * where arguments are joined unquoted, so a quote in the session path would hide what follows it.
 * The system prompt goes on the command line (Grok takes no file for it), last.
 */
export function buildCommand({ threadId, workingDir, model, effort, sandbox, systemPromptFile, promptFile }) {
  const fullAccess = sandbox === fullAccessSandbox;
  if (!fullAccess && process.platform === "win32") throw new Error("Grok Build's read-only sandbox needs macOS or Linux");
  const args = [
    "--output-format", "streaming-messages-json", "--verbatim", "--no-auto-update", "--no-plan",
    "--sandbox", fullAccess ? "off" : "read-only", "--always-approve",
    "--prompt-file", promptFile,
  ];
  if (model !== undefined && model !== null) args.push("-m", model);
  if (effort) args.push("--effort", effort);
  if (threadId) args.push("--resume", threadId);
  if (systemPromptFile) {
    args.push(`--system-prompt-override=${fs.readFileSync(systemPromptFile, "utf8")}`);
    // shortcut: Windows cannot run Grok with a compiled review prompt (33-37 KB), upgrade when Grok takes a system prompt file
    const length = process.platform === "win32" ? windowsLength(["grok", ...args]) : 0;
    if (length > WINDOWS_COMMAND_LINE_MAX) {
      throw new Error(`Grok Build cannot take this system prompt on Windows: the command line would be about ${length} characters, over the limit of 32,767`);
    }
  }
  // effort undefined: Grok decides per model (its cache is advisory and the default model is not
  // named), so what it used is unknown; the runner records nothing and the page falls back
  return { cmd: "grok", args, cwd: workingDir, effort: undefined };
}

/** Grok's tool names. A shell result is JSON carrying `exit_code`; a failed command is not an `is_error`. */
const GROK_TOOLS = {
  shell: new Set(["run_terminal_command"]),
  files: new Set(["search_replace", "write"]),
  exitCode(block) {
    try {
      const code = JSON.parse(block.content).exit_code;
      if (typeof code === "number") return code;
    } catch {}
    return block.is_error ? 1 : 0;
  },
};

export const newLogState = () => claude.newLogState(GROK_TOOLS);
export const parseEvents = (allLines, newLines, elapsed) => claude.parseEvents(allLines, newLines, elapsed, GROK_TOOLS);
export const activityItems = lines => claude.logItems(claude.foldLog(newLogState(), lines));
export { foldLog, logItems, logOutcome } from "./claude.js";

/** True when a process command line is a headless Grok turn this runner may kill. */
export function matchesCmdline(cmdline) {
  const { program, words } = programOf(cmdline);
  if (!["grok", "grok.exe"].includes(program)) return false;
  const format = words.indexOf("--output-format");
  return format >= 0 && words[format + 1] === "streaming-messages-json" && words.includes("--prompt-file");
}

// ---------- settings: model catalog, default model, CLI status ----------

const grokHome = () => process.env.GROK_HOME || path.join(os.homedir(), ".grok");

function runGrok(args, timeout = 10000) {
  return new Promise(resolve => {
    const { cmd, args: argv } = resolveSpawn("grok", args);
    execFile(cmd, argv, { encoding: "utf8", timeout }, (err, stdout) => resolve({ ok: !err, stdout: stdout || "" }));
  });
}

/**
 * Effort levels per model id from Grok's own model cache, or null when it cannot be read. The file
 * is not documented, so this is advisory; only `info.reasoning_efforts` is read (the file also
 * holds key fields).
 */
function cachedEfforts() {
  try {
    const models = JSON.parse(fs.readFileSync(path.join(grokHome(), "models_cache.json"), "utf8")).models;
    const out = {};
    for (const [id, m] of Object.entries(models)) {
      const levels = m && m.info && m.info.reasoning_efforts;
      out[id] = Array.isArray(levels) ? levels.map(l => l && l.value).filter(v => typeof v === "string") : [];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The models `grok models` lists ("  * name (default)" for the default, "  - name" for the others;
 * a custom model's name may have spaces, or end in "(default)" itself), each with its effort
 * levels: [] when Grok's cache has the model without levels, null when the levels are not known.
 */
export async function listModels() {
  const r = await runGrok(["--no-auto-update", "models"]);
  // only the list itself: notices above it may be bullet lines too
  const list = r.ok ? r.stdout.split(/^Available models:\s*$/m)[1] || "" : "";
  const ids = [...list.matchAll(/^[ \t]*([*-])[ \t]+(.*?)[ \t]*$/gm)]
    .map(([, mark, name]) => (mark === "*" ? name.replace(/ \(default\)$/, "") : name))
    .filter(Boolean);
  if (!ids.length) throw new Error("grok models listed no models");
  const known = cachedEfforts();
  return ids.map(slug => ({ slug, name: slug, description: "", efforts: (known && known[slug]) || null }));
}

// No defaultModel(): Grok's default comes from its TOML config, its environment and the account
// behind the key. The runner is stdlib only and has no TOML parser, and a partial reader names a
// wrong model on valid files; Settings shows "Grok Build default" instead.

/**
 * `grok --version`. No sign-in check: with an API key the answer depends on the environment of
 * the process that asks, and the dashboard's is not the reviewer's.
 */
export async function cliInfo() {
  const version = await runGrok(["--version"], 5000);
  return { version: (version.ok && version.stdout.trim()) || null, loggedIn: null };
}
