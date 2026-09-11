---
name: closing-keyword-inside-narrative-prose
type: observation
domain: ci
severity: P2
linear: n/a (GitHub macanderson/oxagen#2559, #2865)
date: 2026-09-11
---

**Symptom:** PR #2865 merged and closed #2559, which it explicitly said should stay open. `dod-close-guard` reopened it within six minutes, reporting eight unchecked DoD items, and logged a red run on `main`.

**Root cause:** A commit message in the PR contained the sentence *"What is removed is the claim that it closes #2559."* GitHub scans the squashed merge commit body for `closes #N` and does not care that the phrase sits inside a subordinate clause describing what a comment used to assert. The PR *body* correctly used `Refs #2559`; the **commit message** did not, and a squash merge concatenates every commit message into the body GitHub scans.

**Fix:** Write "finishes #N", "settles #N" or "names #N" in narrative prose. Reserve `Closes #N` for a trailer line, in both PR bodies **and commit messages**. Rephrasing to put the number first ("#2559 is closed by…") does not trigger it, but relying on word order is fragile — avoid the verb entirely near an issue number you do not intend to close.

**Guard:** `dod-close-guard.yml` caught it and reopened the issue automatically. That is the safety net working, and it is the reason this cost nothing. Note the guard signals a reopen by failing the run, so a red `dod-close-guard` on `main` is not necessarily a defect — read the log before treating it as one.

**Watch-outs:** Applies to any repo carrying the SCR-003 DoD guard. Related: [[a-comment-claiming-a-fix-is-a-silent-failure]], which is the same PR's other lesson about prose that asserts more than it should.
