## Served-call gates coverage audit
PR #4728, issue #4666, 2026-09-28.
### What I set out to do
Audit the tests on fix/served-call-gates for unreached branches in apps/mcp/src/servers/call.ts, for asserts that pass without checking their behavior, for mock shapes that break in CI, and for the GitLab 401 paths. Add tests only where they pin a stated invariant or a money path. Nothing could run.
### What I actually did (measurable deltas)
- Read every new branch in call.ts by hand. The claim throw, claim false, requestAnother, kill switch scopes, and the "denied" outcome were already covered with exact text. Two arms stay unreached: the `?? null` at call.ts:208 and the errors arm of call.ts:338, which looks unreachable.
- Added 4 tests (58 lines, test files only): 2 in call.test.ts, 2 in approvals.test.ts.
- Found one defect to report, not test: the claim at call.ts:372 runs before the credential lookup inside executeCall (packages/mcp-studio/src/execute/call.ts:98). A credential failure uses the approval, and the text "Call it again in a minute" sends the agent into a new approval.
- Found readSwitchTargets (ports.ts:94-140) untested. A wrong column there makes server and connection switches miss served calls without an error.
- Confirmed the GitLab test covers group and project, on resolve and mid-flow, with full messages.
### Quality of my decisions
- Best: testing the approval against the transport refusal, not only against the missing environment. The comment at call.ts:304 claims both, and only one was pinned.
- Weakest: I did not write a fake-db test for readSwitchTargets. It sits outside the coverage allowlist and needs a drizzle fake of a two-table read. I reported it instead.
### What I could have done better
- Search for the claim-before-lookup order earlier. It came from reading executeCall, which I opened late.
### What surprised me about this codebase/product
The served path claims the approval inside call.ts, but the credential resolves inside the studio library. The file's own comment on claim order does not hold across that seam.
### Risks I am leaving behind (untouched on purpose, and why)
- Credential failure after the claim used the approval. Production code was out of scope for this lane. The lead fixed it in fc21f1ca5: runTool now reads the credential before the claim.
- readSwitchTargets and the localTransport env name have no test.
### Confidence in the result: medium (the tests follow existing patterns, but none has run in CI)
