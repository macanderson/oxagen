## Self-Evaluation — apps/app shell activity branch coverage — 2026-09-24
### What I set out to do
Cover the 63 uncovered branches of `apps/app/src/features/shell/activity.tsx` (main's apps/app branch coverage 89.1% vs 90%) with behaviour tests, without touching production code.
### What I actually did (measurable deltas)
- `activity.test.tsx`: 4 tests -> 36, all green three runs in a row (~4.7s). Switched to `@/test/intl` so `ReadFailure` (ui catalogue) renders.
- Covers the idle poll (refused/failed/unmounted reads, org scope with no workspace), both drawers in loading/denied/pending/error/empty/partial/populated, selection into Fleet's panel, mark/archive success and three failure shapes, the refresh race and late answers after close.
- Mutation-probed three guards (generation check on success, on failure, `answer.value.ok`): each turned 1-2 tests red; source restored, `git diff` clean.
- By reading, about 56 of the 63 previously uncovered branches now run; coverage was not measured (repo rule forbids a local coverage run).
### Quality of my decisions
- Best: testing races with explicit deferred promises and reopening the drawer to observe the discarded answer, which makes the generation guard observable without reaching into state.
- Weakest: first draft queried buttons by "tool agent" accessible names; jsdom concatenates `block` spans without a space, costing a rerun.
### What I could have done better
- Check the app's INV-13 lint before writing a `next/link` stand-in; `href={href}` in a test trips `no-restricted-syntax`, spreading props does not.
- Count branches from a v8 map of the file rather than by reading, so the report's number could be exact; I had no allowed way to do that here, so I should have asked the caller for the CI coverage JSON instead.
### What surprised me about this codebase/product
The arch lint's computed-href rule applies to test stand-ins too, so mocks must look like the real `SafeLink` call shape.
### Risks I am leaving behind (untouched on purpose, and why)
- `navCounts/result/unread?.key === key` false arms (a route change mid-poll) stay uncovered: they need a pathname change under a live provider, and the task was bounded.
- `value?.readAt ?? ""` and `state?.refresh()` with a null state inside mark/onResolved are unreachable from typed inputs.
### Confidence in the result: high — 36/36 green x3, lint and format clean, three mutations caught.
