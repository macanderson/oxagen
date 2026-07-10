---
description: Ship a feature end-to-end through the full pipeline — surfacing spec, build to quality gates, usability review, launch collateral
argument-hint: <feature description or gap-backlog item>
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

Feature: $ARGUMENTS

Orchestrate the shipping pipeline. Announce each stage, its inputs, and its
verdict before moving on. Do not skip stages; do not proceed past a failed
gate.

STAGE 1 — SPEC. Delegate to **ux-architect**: produce the surfacing spec
(interaction pattern, feedback treatment per outcome and error code,
placement rung + empty-state copy, per-role visibility, all states
enumerated). If the capability is high-dimensional config, the spec must
apply the ai-assisted-config skill's 8-step pattern.

STAGE 2 — BUILD. Delegate to **feature-shipper** with the spec. Hold it to
the quality-gates skill in full: architecture gates, five UI states +
permission-denied, stability gates, performance budget with measured
actuals, accessibility floor, test gates. Thin vertical slices, each flagged
and green.

STAGE 3 — REVIEW. Run **code-reviewer** on the diff and
**usability-reviewer** against the spec, in parallel. BLOCKER findings loop
back to Stage 2; re-review after fixes. Record HIGH findings that were
consciously deferred, with owner and reason.

STAGE 4 — VERIFY. Full suite green; ship checklist from the quality-gates
skill completed item by item; flag + rollout plan documented.

STAGE 5 — TELL THE WORLD. Delegate to **docs-writer** (reference + how-to +
changelog entry) and **launch-marketer** (changelog announcement, launch
post if warranted; claims table verified against the shipped behavior).
Offer **demo-director** a demo-script update if the feature changes any
standard demo path.

STAGE 6 — REFLECT. Collect each agent's reflection per the reflective-memory
skill; append cross-cutting lessons to shared memory. Report: what shipped,
gate results with numbers, deferred findings, and the top lesson for next
time.

Human checkpoints (never bypass): schema migrations, authz changes,
billing/metering correctness, destructive data operations,
compliance-sensitive marketing claims.
