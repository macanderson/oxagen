# External MCP decision rules

The external transport previously called IAM and consent gates but skipped the workspace decision gate. The fix adds a kernel entry for external admission, canonical external rule patterns, strict workspace-rule reads, per-call human approval, and final admission checks before transport.

## Verification

- The isolated `src/runtime/external-tool-rules.test.ts` run passed 22 tests. It is the only local test file run for this change.
- The tests exercise the actual kernel and decision gate with approval IO mocked: deny, human approval, concurrent input identities, revocation during a wait, input changes, expiry, strict loader/fact failure, agent mandate refusal, canonical names, and security events.
- Added CI materializer regressions proving the transport is not called when any decision check refuses or final IAM is revoked. Existing external auto-approval authoring coverage now asserts the explicit unsupported-measures refusal.
- Independent review found approval-row deduplication and stale IAM risks. Unique tool-call IDs and final non-interactive admission checks address both.
- Other tests, package checks and coverage remain CI work. No live MCP transport, production data or paid model was used.

ADR-122 records the authority boundary: deny and human approval apply; external auto-approval and agent-principal mandate execution remain unsupported and refuse explicitly.
