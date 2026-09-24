---
name: policy-source-lives-in-the-frame-body
type: observation
domain: runs
severity: P3
issue: "#4023"
date: 2026-09-23
---

**Observation:** a policy frame's `policy_source` (`bundle`, `kernel`, `human`, `harness`, `managed_settings`) is in the ClickHouse `body` column, the typed body JSON, not in `attrs`. An operator command's name (`command.name`) is in `attrs`. A reader that looks for either in the wrong place gets null and cannot say who decided.
**Scale:** in the #4023 audit, 666 of 1002 `policy_decision` frames were harness permission checks (`policy_source = harness`). A view that lists every policy frame is mostly harness noise, so the Policy tab folds those away.
**Where:** `packages/run-ledger/src/run-frames.ts` (`tachoFrame`, `decisionOf`).
