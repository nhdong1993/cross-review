#!/usr/bin/env node
// MCP stdio server exposing the session verbs as typed tools:
// review_begin, review_wait, review_reply, review_end (a second model reviews; nothing is edited)
// and delegate_begin, delegate_reply (a second CLI implements; it edits the working directory).
// wait and end are shared: they only poll and stop.
//
// Session state lives on disk under <working_dir>/.cross-review/sessions/ and the reviewer runs
// detached, so a review survives this server exiting; call review_wait again with the
// same session_dir to continue.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  IMPLEMENT_SKILL_NAMES,
  REVIEW_SKILL_NAMES,
  beginSession,
  endSession,
  replySession,
  waitSession,
} from "./lib/review-core.js";
import { DEFAULT_REVIEWER, REVIEWER_NAMES } from "./lib/reviewers/index.js";

// Codex allows 60 s per tool call by default (tool_timeout_sec); Claude Code allows far
// longer. The installer sets REVIEW_WAIT_DEFAULT_S (and Codex's tool_timeout_sec) at registration.
const FALLBACK_WAIT_S = 50;
const envWait = parseInt(process.env.REVIEW_WAIT_DEFAULT_S || "", 10);
const DEFAULT_WAIT_S = Number.isFinite(envWait) && envWait > 0 ? envWait : FALLBACK_WAIT_S;

const SKILLS = REVIEW_SKILL_NAMES;
const DELEGATE_SKILL = IMPLEMENT_SKILL_NAMES[0];
// Each reply tool says which session kind it means to drive; replySession refuses the other one
// before rendering or launching, so a read-only-hinted tool can never resume an implementer.

function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  const body = { error: error.message, code: error.code || "UNKNOWN_ERROR" };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

function tool(handler) {
  return async (args) => {
    try {
      const result = await handler(args);
      // review_end reports a failed finalize in `error` after still stopping the session
      if (result && result.error) return { ...ok(result), isError: true };
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  };
}

const INPUT_HELP = "Markdown with the skill's placeholder values: optional front-matter of `NAME: value` lines between `---` lines, then one `## NAME` section per multi-line value (e.g. `## USER_REQUEST`).";

// The review_* tools never edit the project: they keep session state under .cross-review/ and run a
// reviewer told not to modify project files. Claude Code plan mode refuses MCP tools without this
// hint. The delegate_* tools below do edit the project and are hinted accordingly.
const ANNOTATIONS = { readOnlyHint: true };

// The MCP client's clientInfo (e.g. {name: "claude-code", title: "Claude Code"}): who runs the review.
function callerInfo(server) {
  const info = server.server.getClientVersion();
  if (!info || typeof info.name !== "string" || !info.name) return undefined;
  const caller = { name: info.name };
  if (typeof info.title === "string" && info.title) caller.title = info.title;
  if (typeof info.version === "string" && info.version) caller.version = info.version;
  return caller;
}

function createServer() {
  const server = new McpServer({ name: "cross-review", version: "15.0.0" });

  server.registerTool("review_begin", {
    title: "Begin a review",
    annotations: ANNOTATIONS,
    description: "Start a review session: render round 1 for the skill and launch the reviewer in the background. Returns session_dir; peer skills (review-think, review-pr) also return analysis_prompt for the orchestrator's independent analysis. When the user turned on Follow reviews in the dashboard, also dashboard_url (the session's live page; you may give it to the user) or dashboard_error (the review runs anyway).",
    inputSchema: {
      skill: z.enum(SKILLS),
      mode: z.string().optional().describe("review-impl: working-tree | branch"),
      input: z.string().describe(INPUT_HELP),
      working_dir: z.string().describe("Absolute path of the repository under review"),
      model: z.string().optional().describe("Reviewer model; omit to use the settings for the chosen reviewer (workspace, then global), else the reviewer CLI default. Remembered for later rounds."),
      effort: z.string().optional().describe("Reasoning effort; omit to use the settings for the chosen reviewer, else high. Remembered for later rounds."),
      timeout_seconds: z.number().int().positive().optional(),
      reviewer: z.enum(REVIEWER_NAMES).optional().describe(`Reviewer CLI; omit to use the dashboard settings, else ${DEFAULT_REVIEWER}. Remembered for later rounds.`),
    },
  }, tool(a => beginSession({
    skill: a.skill,
    mode: a.mode,
    inputText: a.input,
    workingDir: a.working_dir,
    model: a.model,
    effort: a.effort,
    timeout: a.timeout_seconds,
    reviewer: a.reviewer,
    caller: callerInfo(server),
  })));

  server.registerTool("review_wait", {
    title: "Wait for the current review round",
    annotations: ANNOTATIONS,
    description: `Wait up to max_wait_seconds (default ${DEFAULT_WAIT_S}) for the reviewer. Returns the round status, parsed review, activities, and next: running (call again), respond (reply), cross_check (peer skills: compare with your analysis, then reply or end with an outcome), done (end), ask_user, or stopped.`,
    inputSchema: {
      session_dir: z.string(),
      max_wait_seconds: z.number().int().min(0).optional(),
    },
  }, tool(a => waitSession(a.session_dir, { maxWaitSeconds: a.max_wait_seconds ?? DEFAULT_WAIT_S })));

  server.registerTool("review_reply", {
    title: "Send the next review round",
    annotations: ANNOTATIONS,
    description: "Render the skill's next-round template from the input and resume the reviewer thread. Model and effort default to the session's stored values.",
    inputSchema: {
      session_dir: z.string(),
      input: z.string().describe(INPUT_HELP),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
  }, tool(a => replySession(a.session_dir, { inputText: a.input, model: a.model, effort: a.effort, expectedKind: "review" })));

  server.registerTool("review_end", {
    title: "End a review session",
    annotations: ANNOTATIONS,
    description: "Finalize (on a normal end) and stop the session. Peer skills pass outcome consensus or stalemate when their exit rule is met; otherwise the session is only stopped.",
    inputSchema: {
      session_dir: z.string(),
      outcome: z.enum(["consensus", "stalemate"]).optional(),
    },
  }, tool(a => endSession(a.session_dir, { outcome: a.outcome })));

  // delegate_*: the implementation side. These make the chosen CLI edit files in working_dir, so
  // they are not read-only and Claude Code plan mode must refuse them.
  const WRITES = { readOnlyHint: false };

  server.registerTool("delegate_begin", {
    title: "Delegate an implementation task",
    annotations: WRITES,
    description: `Hand one implementation task to another CLI (${DEFAULT_REVIEWER} by default). The CLI EDITS FILES in working_dir with full access, then reports what it changed; it is told never to commit, push or switch branches. Give parallel tasks their own git worktree. Poll with review_wait and close with review_end. Returns session_dir, and dashboard_url/dashboard_error when Follow reviews is on.`,
    inputSchema: {
      input: z.string().describe(INPUT_HELP),
      working_dir: z.string().describe("Absolute path of the repository the CLI may edit"),
      model: z.string().optional().describe("Model; omit to use the settings for the chosen CLI, else its default. Remembered for later rounds."),
      effort: z.string().optional().describe("Reasoning effort; omit to use the settings, else high. Remembered for later rounds."),
      timeout_seconds: z.number().int().positive().optional(),
      reviewer: z.enum(REVIEWER_NAMES).optional().describe(`CLI that does the work; omit to use the dashboard settings, else ${DEFAULT_REVIEWER}. Remembered for later rounds.`),
    },
  }, tool(a => beginSession({
    skill: DELEGATE_SKILL,
    inputText: a.input,
    workingDir: a.working_dir,
    model: a.model,
    effort: a.effort,
    timeout: a.timeout_seconds,
    reviewer: a.reviewer,
    caller: callerInfo(server),
  })));

  server.registerTool("delegate_reply", {
    title: "Send change requests to the implementer",
    annotations: WRITES,
    description: "Render the revision round from the input and resume the implementer's thread; it EDITS FILES again. Use after reading the real diff. Model and effort default to the session's stored values.",
    inputSchema: {
      session_dir: z.string(),
      input: z.string().describe(INPUT_HELP),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
  }, tool(a => replySession(a.session_dir, { inputText: a.input, model: a.model, effort: a.effort, expectedKind: "implement" })));

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`cross-review MCP server failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
