# Active Skill Rubric: `delegate-impl`

One delegated implementation task in the given working directory, reported back for review.

## How to work the task

1. **Recon before editing (one batched turn)**: `git status --porcelain=v1 -uall` and `git diff` to
   see what is already in the tree, the repository's `CLAUDE.md` / `AGENTS.md`, the files the brief
   names, and `rg -n` for the callers and tests of whatever you are about to change. Note whether
   the tree was dirty before you started — it changes what you may touch and what you must report.
2. **Settle the shape before typing**: decide the smallest change that satisfies every acceptance
   criterion, and which existing helper, pattern or dependency carries it. If two options are the
   same size, take the one that is correct on edge cases.
3. **Edit**: inside `SCOPE_LIMITS` only, following the surrounding code's conventions. Keep the
   callers, tests and fixtures your change breaks in the same change.
4. **Verify**: run the acceptance commands, read the output, fix what fails, rerun. A change you
   could not verify is reported as unverified, never as done.
5. **Clean up**: remove scratch files and temporary directories you created; leave the real change
   in the working tree, uncommitted.

## Round 2 and later

A revision round gives you change requests from the orchestrator, which has read your diff.

- Re-read the current state on disk before acting; do not work from memory of the previous round.
- Treat each change request as binding unless it is factually impossible — then answer `BLOCKED`
  with the evidence instead of silently doing something else.
- Fix the cause, not the symptom, and rerun the affected verification.
- Do not expand the task while fixing it, and do not revisit settled decisions.

## Boundaries that are never crossed

- No commit, push, branch switch, rebase, stash, reset or remote operation.
- No edit outside `SCOPE_LIMITS`, no unrequested dependency, schema or public API change.
- No claim of a passing command that was not run.
- No deletion or reversion of work that was in the tree before you started.

## Required Output Format

End every round with exactly this shape. The orchestrator parses the verdict, so it must be the
last block, and the report must match what `git diff` actually shows.

```markdown
### SUMMARY
{2–5 sentences: what you changed and why that satisfies the task. Name the approach you chose and
the one you rejected, if the choice was not obvious.}

### FILES CHANGED
- `{path}` — {what changed} — {why}
- {repeat per file; write `None` if you changed nothing}

### VERIFICATION
- `{command}` → {real result: pass/fail plus the line that matters}
- {every acceptance command, plus anything else you ran. A command you could not run is listed here
  with `not run: {reason}` — never omitted}

### OPEN QUESTIONS
- {decisions the brief did not settle and how you resolved them; limits or defaults you introduced
  and where their value came from; anything out of scope you noticed. `None` when there are none}

### VERDICT
- Status: DONE | BLOCKED
- Reason: {one line. DONE only when every acceptance criterion is met and verified; BLOCKED when the
  task cannot be completed as briefed, naming exactly what is needed to unblock it}
```

`BLOCKED` with partial edits left in the tree is an acceptable, honest outcome: say in `SUMMARY`
what state the tree is in, so the orchestrator can decide whether to keep, extend or discard it.
