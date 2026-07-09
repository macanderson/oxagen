---
name: ci-fixer
description: How to diagnose and fix a failing CI run as an agent — read the real logs, reproduce the failure locally, distinguish a code defect from flake or an environment problem, fix the root cause, and confirm the pipeline goes green — without masking the failure.
metadata:
  weight: high
  category: engineering
---

# Fixing a failing CI run

Load this skill when a continuous-integration run is red and needs to go
green. The trap is treating "make CI pass" as the goal — the goal is a
correct build, and a green check that hid the problem is worse than a red
one that named it. Fix the cause, not the signal.

## Read the failing job, not the summary

Open the actual failing job and read its logs to the first real error,
not the final "job failed" line. CI output is noisy and the true cause is
usually far above the last line — a compile error, a failed assertion, a
missing binary, a non-zero exit. Identify which step failed and what it
was actually doing before you form any theory.

## Classify the failure before fixing it

CI failures fall into a few kinds, and each wants a different fix:

- **Code defect** — a real bug or broken test the change introduced. Fix
  the code.
- **Flake** — passes on re-run with no change; a race, a timing
  assumption, or test order dependence. Fix the flaky test's cause; do
  not just retry until it's green.
- **Environment / config** — a missing dependency, an unset variable, a
  version mismatch, a resource that is not available in CI. Fix the
  pipeline or config, and check whether it also breaks locally.
- **Infrastructure** — the runner itself failed to start or timed out,
  independent of the code. Confirm it is truly infra (not a config the
  repo controls) before waiting it out or retrying.

Guessing the class wrong sends you fixing the wrong thing.

## Reproduce it the way CI does

CI fails for reasons that never appear locally: a clean checkout, a
different working directory, environment variables the pipeline sets,
services reachable by a hostname rather than localhost, a frozen
lockfile. Reproduce the failure under those conditions — a fresh
checkout, the same command CI runs, the same env — so you are fixing the
failure CI sees, not a different one that happens to pass on your machine.

## Fix the cause, and never mask it

Do not make a check pass by weakening it: deleting the failing assertion,
lowering a coverage threshold to below the actual number, skipping the
test, or adding a blanket retry around a real failure. Each of these
turns a true signal into a false green and leaves the defect in place.
The only acceptable "make it pass" is a fix that makes the underlying
thing actually correct.

## Keep pipeline and task config in sync

When a failure comes from configuration, remember that a value set in one
place often has to be declared in another to reach the task — an env var
the workflow sets may be stripped unless the task also lists it, a new
job may need matching cache or permission config. Change both halves
together, or the fix works in one context and silently fails in the
other.

## Confirm green for the right reason

After the fix, re-run the failing job and confirm it passes — and confirm
it passes *because the problem is gone*, not because it was retried into a
lucky pass or the check was loosened. Verify the specific thing that
failed now succeeds. A pipeline that is green because you fixed the cause
is done; a pipeline that is green because you stopped looking is a
regression waiting to be rediscovered.

## Record the non-obvious ones

When a CI failure had a cause that was not visible from the logs — an
environment quirk, an ordering trap, a config that must be declared in
two places — write it down where the next person hits it. CI traps recur,
and a captured one is fixed in minutes instead of rediscovered in hours.
