# ADR-159: The Run page draws every panel of the mockup, and a figure the record lacks reads not recorded

Status: Accepted
Date: 2026-09-24

## Context

The Run page audit of 2026-09-24 (`mockups/pages/run.audit-prompt.md` in the roadmap repository) failed 16 of its 17 checks against the build #3795 left. The page drew its own layout in places: a Work and CI panel, a follow-through panel and an issue connections panel above the columns, pill counts on the tabs, an Approvals panel and a frames table where the design draws a timeline and a frame player, and a Cost tab of a waterfall and a key/value list where the design draws Model fit, six instruments, Spend by area, Tool calls, the waterfall table, the token classes and Prompt composition.

Part of the gap was a rule. `apps/app/ARCHITECTURE.md` §3.6 says an in-page slice with no backing renders nothing. On the Run page that rule deleted panels the design draws: whole panels disappeared because one of their figures had no store, and the page stopped looking like the mockup it is measured against. The audit asks the opposite: a row the spec marks unbacked renders an honest "not recorded" that names the gap, never a zero and never nothing.

The maintainer asked on 2026-09-24 for the Run page to look exactly like the mockups.

## Decision

The Run page draws every panel, heading, column and control of the mockup's `pRun`, in the design's order, with the design's copy. Each figure comes from the record or reads "not recorded":

- One derivation, `apps/app/src/features/run/metrics.ts`, reads the run row, the cost rollup, the whole-run transcript and the organization's price book, and every figure on the page reads it. The stat row, the Cost tab's instruments and tables, and the Context tab cannot disagree.
- A figure the record carries is printed with its basis. A figure derived from the record says what it was derived from. A figure no store carries reads "not recorded", and where a whole panel has no backing (speculative prefetch, the measured prompt parts, the prompt window) the panel draws its heading and columns and one line naming what is not recorded.
- The Model fit reading (`fit.ts`) is generated from the run's prompts, failed tool calls, turns and steps, never from reasoning share. It names a capability class, never a model id, and changes nothing on its own.
- Fork replay and Bisect return to a sealed run's header, as the design draws them. `DEREGISTERED.md` §15 drops them.

This amends §3.6 for the Run page only. Every other page keeps the rule that an unbacked slice renders nothing until its lane lands.

## Consequences

A reader sees the whole shape of a run, including what Oxagen does not record yet, and each "not recorded" is a gap with a name rather than a missing panel. A reviewer can check the page against the mockup panel for panel.

The page carries more components with no data behind them today. Each one is a place a future contract lands without a layout change, and each one is held by a test that it prints "not recorded" rather than a zero.

The roadmap spec `mockups/pages/run.md` still lists Spend by area as the third side panel. The mockup moved it to the Cost tab, and the build follows the mockup.
