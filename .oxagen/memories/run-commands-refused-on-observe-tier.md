---
name: run-commands-refused-on-observe-tier
type: bug
domain: runs
severity: P1
issue: "#4023"
date: 2026-09-23
---

**Symptom:** Pause, resume, steer and cancel were disabled on the Run page and `dispatch_command` returned `conflict / observe_tier` for every observe-tier run, which was 23 of 30 live runs in production.
**Root cause:** the dispatch handler treated the enforcement tier as reachability. The tier says whether a policy verdict was enforced. Whether a command reaches the run depends only on the host's command poll.
**Fix:** `commandBlockOf` (`packages/oxagen/src/contracts/run.list.ts`) is the one rule: `run_sealed`, `no_host`, `host_revoked`, `host_offline` (no poll in 5 minutes), or null. The handler refuses with it and every run row carries it as `commandBlock`. ADR-163.
**Guard:** `packages/handlers/src/tacho.command.dispatch.test.ts` queues a command on an observe-tier run with a live host and refuses each block reason.
**Watch-outs:** a UI surface that offers controls must read `commandBlock`, not the tier. A steer's recorded delivery mode must match what the host advertises (`steer_next_step`), or the record promises a delivery time the host does not keep.
