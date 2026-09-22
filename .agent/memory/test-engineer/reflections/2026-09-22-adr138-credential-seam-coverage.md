## Self-Evaluation — ADR-138 credential seam coverage audit (packages/tacho) — 2026-09-22

### What I set out to do
Find the untested branches that matter in the gateway credential seam (run-token codec, custody store, harness file writer, daemon issuer, proxy swap, CLI enroll/unenroll steps) and write the tests into the existing files or new co-located ones, then run each touched file in isolation and typecheck.

### What I actually did (measurable deltas)
- `src/host/run-token.test.ts`: 8 → 13 tests (static ttl clamp both ways, signed-but-not-claims and non-canonical refusals, peek on junk and forgeries, damaged key file not silently replaced, hex casing).
- `src/host/credential-store.test.ts`: 8 → 11 (junk key file refuses rather than re-keys over sealed data, AAD binds the provider so a relabelled entry does not open, release one keeps the other; aligned the first test when the concurrent rewrite dropped `digest` from `status()`).
- `src/host/model-credential.test.ts`: 12 → 22 (edited-since-apply restore, re-take of a key put back, CRLF/tab preservation, lost or junk receipt still restores the key, Codex user-key wins, orphan detection on unparseable files, read on junk does not throw, managed helper equal to ours is no shadow).
- New `src/collector/credential-issuer.test.ts`: 7 tests over a real recorder, store and key (400 harness, 403 host status, 403 no custody and unreadable store, ttl and placement handling, static bound by enrollment expiry, record failure leaves the mint standing).
- New `src/collector/model-routes.test.ts`: 6 tests (credential header swap drops both headers and keeps order, passthrough without attach, Content-Length restatement, response hop headers, both vendors' 401/403/5xx shapes).
- `src/collector/model-proxy.test.ts` seam block: 5 → 8 (vendor 401 shapes and malformed token over the wire, operator pause outranks the seam, damaged store fails closed for a run token and reports harness_held; socket route 400 shape).
- `src/collector/collector-units.test.ts`: `/credential/issue` is 404 on a daemon without the seam.
- Two source fixes, both mutation-checked (test fails with the fix reverted) and committed by the parent as `2bd5f75`: `restoreClaude` puts a released key back without its receipt; `restoreCredentials` skipped a harness whose custody could not be read (later reshaped by the rewrite into unenroll/passthrough modes).
- `cli.test.ts`: my block was overtaken by a concurrent rewrite of `cli/credential.ts`; the other agent re-aligned and extended it (15 tests, green). I stopped whole-block edits there once I saw the file moving.

### Quality of my decisions
- Best decision: reading `restoreClaude` and `restoreCredentials` side by side against the release call in the CLI before writing tests, which surfaced two key-loss paths, and mutation-checking each fix's test by reverting the fix.
- Weakest decision: writing a large CLI block by whole-region Python replacement while another agent was rewriting the module under test and the same test file. One edit aborted on a stale anchor and the block I had written was superseded within minutes.

### What I could have done better
- Check `git status` and file mtimes before the first edit, not after the first surprising failure. The `M` on files I had not touched was the signal that the tree was contested; I saw it late.
- For a shared test file in a contested tree, make small anchored insertions (one `it` at a time) instead of replacing a region, so a concurrent edit produces a conflict on one test rather than a lost block.
- The first version of my `credential-issuer` ttl test asserted a throw on `ttl_ms: 0`; that was pinning an accident (an unvalidated caller value reaching the codec), and the rewrite rightly made it a 400. Asking "is this the designed answer or the fallthrough?" before asserting would have got it right first time.

### What surprised me about this codebase/product
- The test `deps()` fixture's enrollment expires in 2027 while `now` is 2026-09-10, so a static token's expiry is the 30-day ceiling rather than the enrollment's; the code comment says "bounded by the enrollment" and a reader assumes it binds.
- The parent commits sub-agent work mid-task (`2bd5f75` landed my two fixes and two test files while I was still writing), and a sibling agent edits the same files. Coordination is by watching the tree, not by messages.

### Risks I am leaving behind (untouched on purpose, and why)
- `unenroll` with an unreadable store now strips the tokens and shreds the store, discarding a key that a retry could have recovered. The rewrite documents this as a decision ("a refusing helper is worse than a missing key"); it is pinned by the other agent's test and is theirs to own.
- `credentialIssue` reports a 200 with no token as "tachod refused ... (200)"; a wart in wording, pinned by the other agent's test.
- No test drives `credentialIssue` over a real socket to a real daemon (the fixture fakes `daemonPost`); the socket route itself is covered in `model-proxy.test.ts`.
- Coverage thresholds were reasoned about from the code, not measured: coverage runs are package-wide by config and forbidden on this machine.

### Confidence in the result: high on the files I own end to end (run-token, credential-store, model-credential, credential-issuer, model-routes, the proxy seam block), medium on `cli.test.ts` (green, but written by two hands). Evidence: each touched file run in isolation after the concurrent changes landed, `tsc --noEmit` clean, two mutation checks.
