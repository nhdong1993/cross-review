# Output Format Contract

> The implementer's report is read next to the real diff. Anything it claims that the diff does not
> show is a finding for the next round, not an accepted result.

Use this exact shape (copy the entire block below as `{OUTPUT_FORMAT}`):

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

**Status rule**: `DONE` requires every `ACCEPTANCE` criterion met and verified by a command that was
actually run. Unverified work, a criterion that cannot be met, a missing precondition, or a change
that would need to go outside `SCOPE_LIMITS` is `BLOCKED` — with the partial state described in
`SUMMARY` so the orchestrator can keep, extend or discard it.
