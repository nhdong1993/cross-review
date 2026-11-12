// Fake `grok` executable for tests. `grok models` prints an invented list the way the real CLI does
// (FAKE_GROK_MODELS_TEXT replaces it, FAKE_GROK_MODELS_FAIL makes it fail); `--version` prints a version. A turn reads its prompt from
// --prompt-file like the real CLI (never stdin), logs {args, prompt, reviewerEnv} to FAKE_GROK_LOG,
// then prints a streaming-messages-json turn whose result is the content of FAKE_GROK_OUTPUT; the
// session id is "session-grok-1". FAKE_GROK_ERROR ends the turn with is_error and that message in
// `errors`. FAKE_GROK_HANG leaves a command open until SIGTERM, then ends the turn as cancelled
// (exit 143), as the real CLI does.
import { writeFakeCli } from "./fake-cli.js";

export const FAKE_GROK_MODELS = [
  "You are not authenticated.", "", "Default model: grok-x-large", "", "Available models:",
  // "local model": a custom model's name may have spaces (real output for [model."local model"])
  "  * grok-x-large (default)", "  - grok-x-small", "  - grok-x-solo", "  - local model", "",
].join("\n");

export function writeFakeGrok(binDir) {
  writeFakeCli(binDir, "grok", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("models")) {
  if (process.env.FAKE_GROK_MODELS_FAIL) { process.stderr.write("error: cannot reach the model list\\n"); process.exit(1); }
  process.stdout.write(process.env.FAKE_GROK_MODELS_TEXT || ${JSON.stringify(FAKE_GROK_MODELS)});
  process.exit(0);
}
if (args[0] === "--version") { process.stdout.write("grok 9.9.9 (invented) [stable]\\n"); process.exit(0); }
const file = args[args.indexOf("--prompt-file") + 1];
let prompt = null;
try { prompt = fs.readFileSync(file, "utf8"); } catch {}
if (process.env.FAKE_GROK_LOG) fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify({ args, prompt, reviewerEnv: process.env.CROSS_REVIEW_REVIEWER ?? null }) + "\\n");
const sid = "session-grok-1";
const print = events => process.stdout.write(events.map(e => JSON.stringify(e)).join("\\n") + "\\n");
const call = command => ({ type: "assistant", message: { id: "msg_0", content: [{ type: "tool_use", id: "call-1", name: "run_terminal_command", input: { command } }] }, session_id: sid });
if (process.env.FAKE_GROK_ERROR) {
  print([
    { type: "system", subtype: "init", session_id: sid },
    { type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, errors: [process.env.FAKE_GROK_ERROR], session_id: sid },
  ]);
  process.exit(1);
}
if (process.env.FAKE_GROK_HANG) {
  print([{ type: "system", subtype: "init", session_id: sid }, call("sleep 97")]);
  process.on("SIGTERM", () => {
    print([
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "tool call did not complete", is_error: true }] }, session_id: sid },
      { type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"], session_id: sid },
    ]);
    process.exit(143);
  });
  setInterval(() => {}, 1000);
} else {
  const text = fs.readFileSync(process.env.FAKE_GROK_OUTPUT, "utf8");
  print([
    { type: "system", subtype: "init", session_id: sid },
    call("git diff"),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: JSON.stringify({ type: "Bash", output: [], exit_code: 0, command: "git diff" }), is_error: false }] }, session_id: sid },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text }] }, session_id: sid },
    { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: text, session_id: sid },
  ]);
  process.exit(0);
}
`);
}
