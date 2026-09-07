# 3. Tacho capability tokens are Biscuit v2

- Status: accepted
- Date: 2026-08-31

## Context

Tacho (design: `docs/design/tacho/`) mints a token when an agent is approved
to act outside its standing grants. The token must carry the exact action
scope, an expiry, optional use limits, and traceability to the approval
event; the wrapper must verify it **offline** inside the agent process, since
enforcement is fail-closed and cannot depend on a network round trip; and a
stolen or replayed token must fail outside the session it was minted for.

Candidates: JWT (plus DPoP for proof-of-possession), macaroons, Biscuit v2.

## Decision

**Biscuit v2**, with a per-session ephemeral keypair bound into the session's
genesis event and into the token via a third-party block.

- Verification is by the Mint's published Ed25519 root public key — no
  callback, no shared secret in the agent process. Macaroons require a
  verifier-side shared secret, which would put minting-equivalent material
  inside every wrapped process: disqualified outright.
- Caveats are first-class datalog checks carried inside the token: scope
  binding, expiry, session binding, use limits, resource patterns. JWT has no
  caveat model; it would need a bespoke claims convention plus DPoP bolted on
  for proof-of-possession, all of it convention rather than mechanism.
- Attenuation is offline: an enterprise gateway can narrow a token's scope
  (never widen it) without contacting the Mint — useful for layered
  enterprise controls and impossible to express in JWT without re-signing.

Default expiry 120 seconds, hard maximum one hour; destructive verbs are
single-use, enforced against the collector's local nonce set. Revocation is
primarily expiry; a small CRL rides the policy-bundle sync for the remainder.

## Why durable

The requirements — offline public-key verification, in-token caveats, holder
proof, offline attenuation — are structural properties of the format, not
library features. Biscuit is the only candidate with all four as mechanism.
A decade from now the token library may change; the shape of the requirement
(capability tokens verifiable at the edge without shared secrets) will not,
and any successor format satisfying it is a drop-in for this decision's
rationale rather than a reversal of it.

## Consequences

- Biscuit libraries are less ubiquitous than JWT; each wrapper SDK carries a
  Biscuit dependency (Rust-native for Stella, wasm/native bindings for
  TypeScript and Python).
- Auditors unfamiliar with Biscuit need the caveat catalog documented — done
  in `docs/design/tacho/approval-tokens.md`.
- Key rotation for the Mint root requires an overlap window in the
  collector's cached key set; designed into the policy-bundle sync.
