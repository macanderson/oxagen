---
name: dod-close-guard-unchecked-by-stub-parity
type: bug
domain: ci
severity: P1
linear: n/a (GitHub macanderson/oxagen#1336)
date: 2026-09-11
---

**Symptom:** Three of the four caller repos called `dod-close-guard.yml` on a moving `@main` ref for weeks. Nothing reported it. It was found by a human reading the four files by hand.

**Root cause:** `tools/scripts/check-dod-stub-parity.mjs` existed precisely to catch this and covered only two of the three replicated DoD stubs — `dod-check.yml` (pin equality) and `dod-recheck.yml` (byte equality). `dod-close-guard.yml` was never in its `CALLERS` loop, and its `pinnedRef()` regex was hard-coded to `dod-check\.yml@`. A check that looks at two of three things is indistinguishable, from the outside, from a check that passes.

**Fix:** The close guard is now a third fact in `divergence()`. It compares what each pin **resolves to** (the blob sha of the workflow at that ref in oxagen) rather than the ref string, because stella pins `2b61b052` and the other three pin `84fe021b` for a file the later commit did not change — comparing refs would report drift that does not exist. `pinnedRef(source, workflow)` is now parameterised. `scr-corpus-check.yml`'s push-path list gained the close guard too, since changing it here is exactly when the four callers must re-pin.

**Guard:** Five unit tests in `check-dod-stub-parity.test.ts`, including the load-bearing one — pins that differ but resolve to the same file must PASS. Also replayed the real pre-fix state (cgp-website and context-graph-protocol at `d51a0d21`): the check now reports two problems where it reported none.

**Watch-outs:** When a check enumerates a set of things to verify, the set itself is unverified. Ask what is NOT in the loop. The most dangerous omission is the item with the most authority — here, the close guard was the only one of the three carrying `issues: write`, and it was the one left out.
