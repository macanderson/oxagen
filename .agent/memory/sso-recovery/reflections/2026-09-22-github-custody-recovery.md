## Self-Evaluation: GitHub custody recovery, 2026-09-22

### What I set out to do

Recover the unfinished GitHub credential custody patch without exposing an installation token to the harness.

### What I actually did

Preserved the original tracked patch and untracked files outside the author worktree. Added a daemon smart HTTP proxy, session-scoped local leases, exact remote configuration with restoration receipts, server-side repository-ID token narrowing, and transport, handler, contract, and Git configuration tests. Kept the feature behind explicit server and local opt-ins.

### Quality of my decisions

- Best: moved the GitHub request into the daemon. Returning a vendor token through Git's helper would have contradicted the custody claim.
- Weakest: the initial Git URL rewrite used Git's prefix matching. Independent review identified collateral routing for similarly named repositories. Exact remote-value replacement now avoids it.

### What I could have done better

- Inspect shared host authorization before using it. It admits suspended hosts for control traffic, so credential minting needs an explicit active-status check.
- Design removal and multivalue remote receipts before implementing configuration. Those requirements changed the first implementation.

### What surprised me about this codebase/product

A signed mandate evaluator allows an unverified bundle in observe mode. A credential proxy must verify the signature before that evaluator so a modified mode cannot authorize token use.

### Risks I am leaving behind

Same-account processes can change Git configuration or use personal credentials outside the proxy. The feature governs its routed transport and records that boundary. A daemon crash can prevent immediate vendor-token revocation, leaving GitHub's expiry as the ceiling.

### Confidence in the result: medium

Independent coverage audit accepted the revised implementation. CI remains the verification gate. No local test suite was run. Tests exercise actual loopback transport and scratch Git configuration with synthetic credentials.
