// delegate-impl: the implementation skill that makes another CLI edit the working tree.
// What is pinned here: the skill-by-verdict matrix (the new DONE cell AND the unchanged review
// contract around it), the shared verdict vocabulary, the prompt templates, and the skill lists
// that are duplicated across the runtime, the config, the prompt compiler and the installer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMPLEMENT_SKILL_NAMES,
  REVIEW_SKILL_NAMES,
  SKILL_TEMPLATES,
  computeNext,
  isImplementSkill,
  skillKind,
} from "../skill-packs/cross-review/scripts/lib/review-core.js";
import { parseOutputMarkdown, parseVerdict } from "../skill-packs/cross-review/scripts/lib/parse.js";
import { CONFIG_SKILLS } from "../skill-packs/cross-review/scripts/lib/config.js";
import { IMPLEMENT_SKILLS, REVIEW_SKILLS } from "../skill-packs/cross-review/scripts/build-prompts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "skill-packs/cross-review");
const RUNNER = path.join(PACK, "scripts", "review-runner.js");
const SKILL = "delegate-impl";

// ---------- registry ----------

test("delegate-impl is the one implementation skill; the four review skills keep their kind", () => {
  assert.equal(skillKind(SKILL), "implement");
  assert.ok(isImplementSkill(SKILL));
  assert.deepEqual(IMPLEMENT_SKILL_NAMES, [SKILL]);
  assert.deepEqual(REVIEW_SKILL_NAMES.slice().sort(), ["review-impl", "review-plan", "review-pr", "review-think"]);
  for (const skill of REVIEW_SKILL_NAMES) assert.equal(skillKind(skill), "review");
  assert.equal(SKILL_TEMPLATES[SKILL].peer, false);
});

test("every list that enumerates skills agrees with the registry", () => {
  const all = Object.keys(SKILL_TEMPLATES).sort();
  assert.deepEqual(CONFIG_SKILLS.slice().sort(), all, "config.js CONFIG_SKILLS");
  assert.deepEqual([...REVIEW_SKILLS, ...IMPLEMENT_SKILLS].sort(), all, "build-prompts.js skill lists");
  assert.deepEqual(REVIEW_SKILLS.slice().sort(), REVIEW_SKILL_NAMES.slice().sort(), "only review skills get the reviewer base");
  assert.deepEqual(IMPLEMENT_SKILLS.slice().sort(), IMPLEMENT_SKILL_NAMES.slice().sort(), "only implement skills get the implementer base");

  const manifest = JSON.parse(fs.readFileSync(path.join(PACK, "manifest.json"), "utf8"));
  for (const skill of all) assert.ok(manifest.skills.includes(skill), `manifest.json lists ${skill}`);

  const installer = fs.readFileSync(path.join(ROOT, "bin/cross-review.js"), "utf8");
  const runnerSkills = JSON.parse(installer.match(/const RUNNER_SKILLS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(runnerSkills.slice().sort(), all, "bin/cross-review.js RUNNER_SKILLS");
});

// ---------- the skill-by-verdict matrix ----------
//
// Branch order in computeNext: stalemate first (any skill), then peer skills (always cross_check),
// then the implement-only DONE branch, then the unchanged APPROVE branch, then verdict/issues, then
// ask_user. The expectations below are the contract; they must fail if any of that order changes.

const PEERS = ["review-pr", "review-think"];
const NON_PEERS = ["review-plan", "review-impl", SKILL];
const VERDICTS = ["APPROVE", "DONE", "BLOCKED", "REVISE", "CONSENSUS", "STALEMATE", null];

function poll({ verdict, blocks = 0, stalemate = false }) {
  return {
    status: "completed",
    convergence: { stalemate },
    review: {
      blocks: Array.from({ length: blocks }, (_, id) => ({ id })),
      verdict: verdict ? { status: verdict } : null,
    },
  };
}

function expected(skill, verdict, blocks, stalemate) {
  if (stalemate || verdict === "STALEMATE") return "done";
  if (PEERS.includes(skill)) return "cross_check";
  if (skill === SKILL && verdict === "DONE") return "done";
  if (verdict === "APPROVE") return "done";
  if (verdict) return "respond";
  return blocks > 0 ? "respond" : "ask_user";
}

test("skill × verdict × convergence: the new DONE cell and the whole existing review contract", () => {
  for (const skill of [...PEERS, ...NON_PEERS]) {
    for (const verdict of VERDICTS) {
      for (const stalemate of [false, true]) {
        for (const blocks of [0, 1]) {
          const got = computeNext(poll({ verdict, blocks, stalemate }), { skill_name: skill });
          assert.equal(
            got.next,
            expected(skill, verdict, blocks, stalemate),
            `${skill} + ${verdict ?? "no verdict"} + ${blocks} blocks + stalemate=${stalemate}`,
          );
        }
      }
    }
  }
});

test("DONE finishes an implementation session and never a review one", () => {
  assert.deepEqual(computeNext(poll({ verdict: "DONE" }), { skill_name: SKILL }),
    { next: "done", next_reason: "completed" });
  for (const skill of ["review-plan", "review-impl"]) {
    assert.equal(computeNext(poll({ verdict: "DONE" }), { skill_name: skill }).next, "respond");
  }
  for (const skill of PEERS) {
    assert.equal(computeNext(poll({ verdict: "DONE" }), { skill_name: skill }).next, "cross_check");
  }
});

test("BLOCKED hands the round back to the orchestrator", () => {
  const got = computeNext(poll({ verdict: "BLOCKED" }), { skill_name: SKILL });
  assert.equal(got.next, "respond");
  assert.equal(got.next_reason, "verdict_blocked");
});

test("a non-completed round is unchanged for an implementation session", () => {
  const cases = [
    [{ status: "running" }, "running"],
    [{ status: "failed", failure_reason: "reviewer_process_exit" }, "stopped"],
    [{ status: "stalled", failure_reason: "stalled" }, "stopped"],
    [{ status: "timeout", timeout_reason: "runner_deadline", recoverable: true, thread_id: "t", progress_observed: true }, "stopped"],
  ];
  for (const [input, next] of cases) {
    assert.equal(computeNext(input, { skill_name: SKILL }).next, next, JSON.stringify(input));
  }
});

// ---------- verdict vocabulary ----------

test("DONE and BLOCKED parse as verdicts; unknown statuses still do not", () => {
  for (const status of ["DONE", "BLOCKED"]) {
    assert.equal(parseVerdict(`### VERDICT\n- Status: ${status}\n- Reason: r\n`).status, status);
    const report = parseOutputMarkdown(`### SUMMARY\ns\n\n### VERDICT\n- Status: ${status}\n- Reason: r\n`);
    assert.equal(report.verdict.status, status);
  }
  assert.equal(parseVerdict("### VERDICT\n- Status: FINISHED\n- Reason: r\n").status, null);
});

// ---------- prompts and templates ----------

function render(template, values) {
  return execFileSync(process.execPath,
    [RUNNER, "render", "--skill", SKILL, "--template", template, "--skills-dir", path.join(PACK, "skills")],
    { input: JSON.stringify(values), encoding: "utf8" });
}

test("both rounds render with their placeholders filled", () => {
  const round1 = render("round1", {
    TASK: "task-value", CONTEXT: "context-value", ACCEPTANCE: "acceptance-value",
    SCOPE_LIMITS: "scope-value", OUTPUT_FORMAT: "format-value",
  });
  for (const value of ["task-value", "context-value", "acceptance-value", "scope-value", "format-value"]) {
    assert.ok(round1.includes(value), `round1 contains ${value}`);
  }
  assert.ok(!/\{[A-Z_]+\}/.test(round1), "round1 has no unfilled placeholder");

  const revision = render("revision", { CHANGE_REQUESTS: "requests-value", CONTEXT: "ctx", OUTPUT_FORMAT: "fmt" });
  assert.ok(revision.includes("requests-value"));
  assert.ok(!/\{[A-Z_]+\}/.test(revision), "revision has no unfilled placeholder");
  assert.ok(/do NOT\s+rely on memory/i.test(revision), "revision tells the implementer to re-read the tree");
});

test("the compiled prompt is the implementer's, not the reviewer's", () => {
  const compiled = fs.readFileSync(path.join(PACK, "prompts", "compiled", `${SKILL}.compiled.md`), "utf8");
  assert.ok(compiled.includes("# System Role: Delegated Implementer"), "implementer identity");
  assert.ok(compiled.includes(`# Active Skill Rubric: \`${SKILL}\``), "skill rubric");
  assert.ok(compiled.includes("Status: DONE | BLOCKED"), "reporting contract");
  assert.ok(!compiled.includes("## 9. Always-On Core Tactics"), "no reviewer tactics layer");
  assert.ok(!compiled.includes("Principal Reviewer"), "no reviewer identity");
  // The reviewer prompts must not have picked up the implementer's permissions
  for (const skill of REVIEW_SKILL_NAMES) {
    const review = fs.readFileSync(path.join(PACK, "prompts", "compiled", `${skill}.compiled.md`), "utf8");
    assert.ok(!review.includes("Delegated Implementer"), `${skill}: no implementer identity`);
  }
});

test("the implementer is told not to commit, push or leave its scope", () => {
  const compiled = fs.readFileSync(path.join(PACK, "prompts", "compiled", `${SKILL}.compiled.md`), "utf8");
  for (const rule of ["Never commit, never push", "SCOPE_LIMITS", "git add -A"]) {
    assert.ok(compiled.includes(rule), `git/scope discipline mentions ${rule}`);
  }
});

test("SKILL.md carries its own loop, the worktree rule and the interrupted-work policy", () => {
  const md = fs.readFileSync(path.join(PACK, "skills", SKILL, "SKILL.md"), "utf8");
  assert.ok(!md.includes("{{PROTOCOL_"), "no shared review protocol: the loop is its own");
  for (const tool of ["delegate_begin", "delegate_reply", "review_wait", "review_end"]) {
    assert.ok(md.includes(tool), `names ${tool}`);
  }
  for (const next of ["`respond`", "`done`", "`ask_user`", "`stopped`"]) {
    assert.ok(md.includes(next), `covers next: ${next}`);
  }
  assert.ok(/worktree/i.test(md), "parallel runs get a worktree each");
  assert.ok(/git diff/.test(md), "the diff is verified against the report");
  assert.ok(md.includes("review-impl"), "the result still goes through the normal review gate");
});
