---
name: launchd-bootout-is-async-reenroll-drops-service
type: bug
domain: tacho
severity: P1
linear: "GitHub #4012"
date: 2026-09-23
---

**Symptom:** After a tacho re-enroll, `launchctl print gui/501/sh.oxagen.tachod` answered "Could not find service" while the plist sat on disk. No daemon ran.
**Root cause:** `launchctl bootout` returns before the old process exits; launchd removes the label only when it does. The install retried `bootstrap` for 1.7 s, the old daemon's SIGTERM path waited on the git lane for longer, and launchd then removed the label the new bootstrap had loaded. `bootstrap` reported success, so nothing noticed.
**Fix:** `packages/tacho/src/host/service.ts` polls `launchctl print` until the label is gone (15 s bound), bootstraps, then checks `print` again and throws if nothing is loaded. An unchanged plist on a loaded service uses `kickstart -k`. `collector/run.ts` bounds shutdown to 5 s; the plist sets `ExitTimeOut` 10.
**Guard:** `service.test.ts` fake launchd that keeps a booted-out label for N polls; `run.test.ts` grace timer.
**Watch-outs:** A successful `launchctl bootstrap` exit code does not mean the service stays loaded. Always confirm with `print`. Any test fake that answers 0 to every launchctl call now models a label that never unloads.
