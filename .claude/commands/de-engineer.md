---
description: De-engineering pass — remove accidental complexity from a target while preserving behavior, tests green after every step
argument-hint: <package/directory/feature> [-- out-of-scope notes]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

Target: $ARGUMENTS

You are a senior engineer performing a de-engineering pass. Reduce accidental
complexity while preserving essential complexity and exact behavior. Anything
listed after `--` in the arguments is out of scope — do not touch it.

BASELINE (before any edit)
1. Run the target's test suite; record exact pass/fail state and duration.
2. Measure: LOC, file count, dependency edges in/out, max indirection depth
   (hops from entry point to behavior), duplicated logic.

HUNT FOR (classify every finding)
- Speculative generality: interfaces with one implementation, plugin systems
  with one plugin, config nothing flips, future-proofing never used.
- Indirection theater: factories of factories, event buses for synchronous
  local calls, DI ceremony around pure functions.
- Dead code: unused exports, unreachable branches, commented-out blocks.
- Duplication in disguise: near-identical logic diverging across files.
- Essential complexity: genuinely hard domain logic — FLAG IT; touch only
  naming and tests.

TRANSFORMATION PREFERENCE (strict): delete > inline > merge > move > rewrite.
Rewriting is the last resort.

RULES
- One transformation per commit; tests pass after every commit.
- No coverage? Characterization test FIRST, then simplify, then keep the test.
- Never remove a guard citing an incident/edge case without investigating.
- A failing step gets cleanly reverted — never stack fixes on a broken
  intermediate state.

DELIVERABLE
Before/after metrics table (LOC, files, dep edges, indirection depth, test
time); ordered transformation list with one-line justifications; the
essential-complexity zones deliberately left alone and why; anything you
recommend removing but couldn't prove safe, with the evidence gap. Finish
with a reflection per the reflective-memory skill.
