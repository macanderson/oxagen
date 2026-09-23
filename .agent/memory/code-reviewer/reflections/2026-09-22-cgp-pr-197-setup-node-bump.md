## Self-Evaluation — context-graph-protocol PR #197 (setup-node v4 to v7) — 2026-09-22

### What I set out to do
Round 1 adversarial review of a Dependabot bump of `actions/setup-node` from v4 to v7 across `ci.yml` (four jobs) and `publish-sdks.yml` (two jobs).

### What I actually did (measurable deltas)
- Compared v4 and v7 `action.yml` and `src/authutil.ts`: runtime node20 to node24, `always-auth` removed, dummy `NODE_AUTH_TOKEN` export removed, `package-manager-cache` auto-detect added.
- Proved the only untested behaviour change (publish-npm `npm install` before the token is set) is harmless: npm 10.9 `env-replace.js` leaves an unset `${VAR}` literal, and registry.npmjs.org returns 200 to public reads with that literal as a bearer token (curl probe).
- Confirmed a real green CI run (35572396588) covers all four v7 jobs.
- Posted review 5285319719 with two P3 findings: the scaffold template still ships v4 and is invisible to Dependabot; the PR carries both `no-issue` and `closes-nothing`.

### Quality of my decisions
- Best: testing the registry response with curl instead of reasoning from the six-year history of the dummy token. It turned an inference into evidence and kept a P1 off the review.
- Weakest: skipping Phase 0 recall. The `gh api --input` drops `-f event=` trap was already in shared lessons from PR #195 earlier today, and I hit it again and had to submit the pending review by hand.

### What I could have done better
- Read `.agent/memory/shared/lessons.md` before the first gh call. The trap I hit was recorded twelve hours earlier by the same agent role.
- Put `event` and `body` inside the review JSON from the start so the review submits in one call.
- Check `original_position` against the diff when `line` comes back null rather than trusting the tsv's blank column at first glance.

### What surprised me about this codebase/product
- The scaffold's workflow lives under `_github/workflows/` so the generated project gets a real `.github/`, which also means no Dependabot config can ever see it.
- `closes-nothing` was applied ten minutes after the run stamp, so labels move on a PR while it is under review.

### Risks I am leaving behind (untouched on purpose, and why)
- The template pin drift has no CI gate. It is P3 and belongs in a follow-up, not on a Dependabot branch.
- The publish path has never run on v7 because it is manual dispatch only. The evidence is a curl probe and source reading, not a run.

### Confidence in the result: high
Evidence: real green run on the head commit, upstream source diff read, npm config source read, registry probe returned 200 for the exact literal npm would send.
