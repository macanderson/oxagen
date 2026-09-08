# Tacho in Stella: native `tacho-core` integration notes

Stella does not use the wrap-a-foreign-object path — it links `tacho-core`
directly, making it the reference implementation of the wrapper contract.

## Integration points

```rust
// Sketch — API shape, not final signatures.
use tacho_core::{Session, Enforcement, CanonicalAction};

// 1. Session start where Stella constructs its agent runtime. The newtype
//    wrapper is the same shape foreign SDKs get via proxy:
let session = Session::start(agent_identity, wrapper_attestation)?;
let agent = TachoAgent::new(agent, session); // TachoAgent<A: Agent>

// 2. Tool dispatch: Stella's executor calls authorize() before every tool
//    invocation. Standing grants hit the cached Cedar bundle (zero network);
//    elevation blocks on the PDP and yields a Biscuit or a deny.
let token = session.authorize(CanonicalAction::tool("payments.refund", resource))?;

// 3. Emission is a lock-free enqueue; the collector connection drains it.
session.emit(Event::tool_call(body, Some(token.id())));
```

## Why native beats proxy here

- **Cedar and Biscuit are Rust-native** (`cedar-policy`, `biscuit-auth`
  crates), so Stella evaluates standing grants and verifies tokens with no
  FFI and no serialization overhead.
- Stella's executor already mediates every tool call and model call, so
  interception is a trait bound, not monkey-patching — `fidelity: "sdk"`
  with complete coverage, the highest-trust telemetry class.
- The per-session hash chain can be computed inline (blake3/sha256 at the
  emission site) before events even reach the collector, shrinking the
  window in which an unflushed tail is unchained.

## Residue for the stella repo

- Define the `Agent` trait bound `TachoAgent` wraps.
- Wire wrapper attestation to Stella's release build hashes.
- Expose the session's CGP episode id so Stella can query its own history
  through its existing CGP host machinery (`tacho:sess_…` anchors).
