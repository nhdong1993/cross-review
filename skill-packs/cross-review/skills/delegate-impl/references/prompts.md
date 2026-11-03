# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction and
> loads the compiled `delegate-impl` system prompt (Layer 1 implementer identity: mandate, scope
> discipline, verification duty and git discipline; Layer 3 `delegate-impl` task rubric and output
> contract).

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{TASK}` | What to implement, stated so it cannot be misread: the behaviour wanted, the files or area it belongs in, and the reason it is wanted | Yes | — |
| `{CONTEXT}` | What the implementer cannot find on its own: decisions already made, constraints, where real samples of the data live, whether the working tree already holds changes it must leave alone, and the shared contract when parallel tasks must agree (error codes, API fields, file layout) | No | "None beyond the task" |
| `{ACCEPTANCE}` | How done is judged: the observable outcome, plus the exact commands that prove it (tests, build, lint) | Yes | — |
| `{SCOPE_LIMITS}` | Paths it may touch, and what it must not do (no dependency, schema, public API or config change unless named here) | No | "Only the files the task needs; no dependency, schema or public API change" |
| `{OUTPUT_FORMAT}` | Copy the entire fenced code block from `references/output-format.md` (the single block after "Use this exact shape") | Yes | — |
| `{CHANGE_REQUESTS}` | Revision rounds: what must change, one numbered item each, with the evidence from the diff or from a command you ran | Yes (round 2+) | — |

---

## Task Prompt (Round 1)
```
## Your Role
Execute one delegated implementation task (`delegate-impl`) in this working directory, under your
active system rubric. You change project files; you do not commit, push or switch branches.

## Task
{TASK}

## Context
{CONTEXT}

## Acceptance
{ACCEPTANCE}

## Scope Limits
{SCOPE_LIMITS}

## How to Work
1. Recon first, in one batched turn: `git status --porcelain=v1 -uall`, `git diff`, this
   repository's `CLAUDE.md` / `AGENTS.md`, the files named above, and `rg -n` for the callers and
   tests of what you are about to change. Note anything already uncommitted — it is not yours.
2. Choose the smallest change that meets every acceptance criterion, reusing what the repository
   already has, and following the conventions of the code around it.
3. Edit only inside Scope Limits, and keep the callers, tests and fixtures your change breaks in
   the same change.
4. Run the acceptance commands, read the real output, fix what fails, rerun. New non-trivial logic
   leaves a test behind in this repository's existing test style.
5. Clean up the scratch files and temporary directories you created.
6. Report in the required format. `DONE` only when every criterion is met and verified; otherwise
   `BLOCKED`, describing the state you are leaving the tree in.

## Required Output Format
{OUTPUT_FORMAT}
```

## Revision Prompt (Round 2+)

```
## Change Requests
{CHANGE_REQUESTS}

## Context
{CONTEXT}

## Instructions
1. Re-read the current state on disk — `git status --porcelain=v1 -uall` and `git diff` — do NOT
   rely on memory of the previous round; the orchestrator may have changed things.
2. Address every change request. Fix the cause, not the symptom, and keep the fix inside the
   original Scope Limits.
3. Do not expand the task, revisit settled decisions, or revert work that was not asked about.
4. A request that is factually impossible is answered with `BLOCKED` and the evidence, not with a
   silent substitute.
5. Rerun the affected acceptance commands and report their real output.

## Required Output Format
{OUTPUT_FORMAT}
```
