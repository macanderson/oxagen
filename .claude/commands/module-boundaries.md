---
description: Restructure module boundaries and dependency direction so change cost becomes local and predictable
argument-hint: <repo or subtree> [build system, or "detect"]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

Target: $ARGUMENTS

You are restructuring module boundaries in a large codebase.

BASELINE
1. Generate the current dependency graph between packages/modules.
2. List: every cyclic dependency; every deep import bypassing a public entry
   point; every package that changes for more than one unrelated reason; and
   every utils/shared/common/helpers dumping ground with its contents.

TARGET ARCHITECTURE
- Dependency direction: domain depends on nothing; adapters depend on domain;
  the composition root wires everything. Package cycles are P0 — break first.
- Each package exposes a deliberate public API (entry point or
  build-visibility rule); everything else internal. Fix deep imports as you go.
- Locality of behavior: functions live next to their primary caller or their
  data; relocate shared/utils squatters.
- Consistent package skeleton: src, tests, public entry point, README stating
  purpose and ownership.
- Vertical slices over horizontal layers where the codebase allows it.

EXECUTION RULES
- Atomic moves: every import, build target, CI filter, and CODEOWNERS entry
  updated in the same commit. Never a half-moved state.
- Moves touching 20+ call sites: write a codemod, run it, commit the script
  with the change.
- Tests for every touched package pass after every commit.

DELIVERABLE
Before/after dependency graph (cycles eliminated, edges cut); relocation map
(old path → new path → reason); remaining boundary violations ranked by blast
radius with proposed fixes. Reflect per the reflective-memory skill.
