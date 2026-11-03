---
name: delegate-impl
description: Hand one implementation task to an external CLI (Codex by default; Claude Code or Antigravity on request) that edits files in a working directory you give it, reports what it changed, and answers change requests. You write the brief, verify the real diff against the report, and review the result. Use for self-contained tasks you want done by another model, or for several tasks in parallel, each in its own git worktree.
---

# Delegated Implementation

## Purpose
Make a second CLI do a scoped piece of implementation work and report back, so you can review its
diff instead of writing the code yourself. Unlike the `review-*` skills, the delegated CLI **edits
project files**: it runs with the adapter's full-access sandbox, and its prompt requires changes.

## When to Use
A task that can be stated completely in writing and judged objectively: a contained feature, a
mechanical refactor across known files, a fix with a reproducible failure, a migration script. Also
when several such tasks are independent and you want them running at once.

Not for: work you cannot state crisply, decisions the user still owes you, or anything that needs
the conversation's context to get right. Do it yourself instead — a vague brief returns a confident
wrong diff.

## Inputs
- **Working directory**: absolute path the CLI may edit. Give each parallel task its own git
  worktree; two delegates in one checkout overwrite each other. Start from a clean tree, or tell
  the implementer in `CONTEXT` what is already uncommitted and must be left alone.
- Round 1 placeholders: `TASK` (what to build, in enough detail that it cannot be misread),
  `CONTEXT` (what it cannot find on its own: decisions, constraints, where the real samples live,
  state of the tree), `ACCEPTANCE` (how done is judged, plus the exact commands to run),
  `SCOPE_LIMITS` (paths it may touch; what it must not do), `OUTPUT_FORMAT` (copy the fenced block
  from `references/output-format.md`).
- Revision placeholders: `CHANGE_REQUESTS`, `CONTEXT`, `OUTPUT_FORMAT`.
- Skill `delegate-impl`, no mode.

## Running the task
The runner keeps all session state; you supply content and follow `next`.

- **Tools.** `delegate_begin` and `delegate_reply` (server `cross-review`) start and continue the
  work — they make the chosen CLI write files. Poll with `review_wait` and close with `review_end`:
  those two only poll and stop, and work for any session. Without the MCP tools, or when the client
  refuses a call, run the same verbs through the CLI:
  `node "{{RUNNER_PATH}}" begin --skill delegate-impl --input <file|-> --working-dir <dir>`, then
  `wait <session_dir>`, `reply <session_dir> --kind implement --input <file|->` (the `--kind` is
  required: without it the CLI refuses to resume an implementation session) and `end <session_dir>`;
  each prints JSON. Run every verb of one session from the same sandbox context.
- **Input.** One markdown string of placeholder values: `NAME: value` lines first (optionally
  between `---` lines), then one `## NAME` section per multi-line value.
- **Start:** `delegate_begin {input, working_dir, reviewer?, model?, effort?}`.
- **Who does the work.** Pass `reviewer` (`codex`, `claude` for Claude Code, `agy` for Antigravity),
  `model` or `effort` only when the user names one; otherwise omit them and the settings decide
  (workspace, then global), else Codex with its default model and effort `high`. Never choose one
  from the size of the task. The session keeps them for every round.
- **Wait:** `review_wait {session_dir}` until `next` is not `running`. Report the specific
  `activities` (e.g. "implementer: editing src/auth.js"), never just "running".
- **Act on `next`:** in every case below except `running`, **look at the tree before you act** —
  `git status --porcelain=v1 -uall` and `git diff` — because the implementer may have left edits
  behind, and never start a fresh session over a dirty tree left by a dead one.
  - `respond`: the round ended with `BLOCKED` or with open points. Decide what you want changed or
    answer what it asked, then `delegate_reply {session_dir, input}` and wait again.
  - `done`: it reported `DONE`. Verify (below), then `review_end`, then report.
  - `ask_user`: the round produced no verdict. Read `review.raw_markdown`, inspect the diff, tell
    the user what state the work is in, and ask how to proceed.
  - `stopped`: an error, stall, or timeout ended the round, and the tree may hold half-finished
    work. Call `review_end` once (it only stops) and report `next_reason`, the partial `review` and
    what the diff actually shows. When the implementer had started (the result has a `thread_id`),
    the same session can be continued with `delegate_reply`, which keeps its context: tell the
    user, and resume when they ask, with a `CONTEXT` note that the previous turn was interrupted,
    what is already on disk, and that it must finish rather than redo the work. Do not discard or
    revert the partial edits on your own, and do not start a replacement session by yourself.
- `status: completed` means the CLI finished its turn, not that the task is done; only `next` decides.

## Verify before you believe the report
The report is a claim; the diff is the evidence. Before `review_end`, and before telling the user
anything is done:
1. Read the real diff (`git status`, `git diff`), not just `FILES CHANGED`.
2. Check nothing outside `SCOPE_LIMITS` was touched, and that no commit, branch switch or push
   happened (`git log --oneline -3`, `git status -sb`).
3. Run the `ACCEPTANCE` commands yourself. A command the report calls passing that you have not run
   is not passing.
4. Anything the report does not account for — an extra file, a dropped test, a silent dependency —
   goes back as a `CHANGE_REQUESTS` round, not into your summary as done.

Then run `review-impl` on the resulting diff as you would on your own work; a delegated change gets
the same gate, not a lighter one.

## Completion
Report what was delegated, to which CLI, rounds used, what the diff really contains, what you
verified yourself, and anything left open or blocked. The work stays uncommitted in the tree: you
decide, with the user, what to commit.

## Rules
- If in plan mode, exit plan mode first; this skill changes code through another CLI.
- One delegate per set of files. For parallel tasks, one git worktree each, and say in each
  `CONTEXT` which contract (error codes, API fields, file layout) is shared, or they will diverge.
- You own the repository's history: the implementer never commits, pushes or switches branches, and
  neither do you on its behalf without the user asking.
- Never pass a secret, token or credential in the brief.
- A `BLOCKED` report is information, not failure: read what it found before deciding to retry,
  rescope, or do the task yourself.
