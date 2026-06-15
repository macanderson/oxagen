---
name: debugging
description: How to investigate a failure as an agent — reproduce it, read the actual error, narrow to the smallest reproducer, fix the root cause rather than the symptom, and land a regression test.
metadata:
  weight: high
  category: engineering
---

# Debugging a failure

Load this skill when something is broken. The order of steps matters:
most wrong-cause fixes come from skipping straight to a guess.

## Reproduce it first

Get the failure to happen on demand before changing anything. A bug you
cannot reproduce is a bug you cannot confirm you fixed. Capture the exact
inputs, environment, and steps that trigger it.

## Read the actual error

Read the real error message, stack trace, and logs — not what you assume
they say. The failing line, the failing assertion, or the non-zero exit
code usually names the problem directly. Resist forming a theory until
you have read the evidence.

## Narrow it down

Shrink the problem until the cause is obvious. Remove or stub parts of
the system until the failure disappears, then add the last piece back —
that piece is where the cause lives. Binary-search a large surface
rather than reading all of it.

## Find the root cause, not the symptom

Ask why the failure happened, then why that happened, until you reach a
cause you can fix at the source. Patching the symptom — swallowing the
error, adding a retry, special-casing the one input that broke — leaves
the real defect in place to resurface later.

## Fix, then prove it

Reproduce the failure in the smallest possible automated test, make that
test fail, then fix the code so it passes. Land the test with the fix so
the same regression cannot return quietly. Verify the original
reproduction steps now succeed end to end.

## Write down what you learned

When a fix reveals a non-obvious cause or a trap others could fall into,
record it where the next person will find it — a comment at the site, a
note in the issue, or a short entry in the project's running notes. A
hard-won root cause that nobody captures gets rediscovered the hard way.
