<!-- Re-homed from macanderson/cgp-website docs/design/tacho/trust-scoring.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho trust scoring

- Status: draft design
- Date: 2026-08-31
- Parent: [overview.md](overview.md)

## 1. Model: Beta-Bernoulli posterior over risk-weighted incident rate

One model, chosen for durability: the score *is* a credibility-weighted loss
frequency — the quantity underwriters already price — rather than an opaque
point system. It also handles low-volume agents naturally: little evidence →
wide posterior → conservative score.

### Exposure and incidents

- Every completed action contributes **exposure**
  `w = risk_weight(kind, scope)` — network egress > file write > file read.
- Every **incident** contributes `w · severity`. Incidents are: policy
  violations, token-misuse attempts (`token_denied` after tampering or
  replay), unhandled errors causing rollback, human-reported incidents, and
  corroboration discrepancies (SDK-reported vs proxy-observed egress
  disagreeing).

### Decay and posterior

Maintain exponentially decayed sums with half-life ≈ 90 days
(`λ = 2^(−Δt / 90 d)`):

```
E ← E·λ + w          (exposure)
I ← I·λ + w·severity (incidents)
```

Posterior incident rate `p ~ Beta(α₀ + I, β₀ + E)` with a weakly conservative
prior (`α₀ = 1, β₀ = 20`).

### Score

```
score = 1000 · (1 − UCB₉₅(p))
```

Using the 95th-percentile upper confidence bound (not the mean) means:

- a new agent starts modest and the score **rises only as evidence
  accumulates** — tenure and volume are rewarded automatically, no separate
  "age bonus";
- a single severe incident both shifts and widens the posterior, so the score
  **drops immediately**, then recovers along the decay curve — exactly the
  telematics dynamic ("two hard brakes cost you; six clean months earn it
  back");
- an idle fleet cannot farm score: no risk taken → little exposure → the
  posterior stays wide and the UCB stays high.

### Initial risk weights

| Action class | `w` |
| --- | --- |
| read (file/context) | 1 |
| file write | 3 |
| tool call, non-destructive | 3 |
| network egress | 5 |
| tool call, destructive verb (delete, refund, deploy) | 10 |
| elevated action (ran under a minted token) | 2× the base class |

Severity ∈ {1 minor, 3 major, 10 critical}, set by incident type with human
override.

## 2. Tiers gate auto-approval

Tier is computed from the score and fed to the PDP as a Cedar context
attribute (`context.trust_tier`), so enterprises can override per policy.

| Tier | Score | Auto-approval behavior |
| --- | --- | --- |
| T0 | < 400 | Everything escalates to a human. |
| T1 | 400–649 | Auto-approve low-risk elevations; short expiries. |
| T2 | 650–849 | Auto-approve medium-risk; longer expiries, bounded parameters. |
| T3 | ≥ 850 **and** ≥ 90 days tenure | Auto-approve high-risk; humans only for critical verbs. |

## 3. Anti-gaming — the self-reported-telemetry problem

The dashcam is inside the car; the driver could unplug it. Mitigations, in
combination:

1. **Wrapper attestation.** The score is computed only over sessions whose
   genesis event carries a signed wrapper build hash (and, where the platform
   provides it, runtime attestation). Unattested sessions record but do not
   earn score.
2. **Corroboration bonus.** Fleets running the egress proxy alongside the SDK
   get network events cross-checked: SDK-reported egress must reconcile with
   proxy-observed egress. Reconciled fleets score against a lower-variance
   posterior; discrepancies are incidents.
3. **Gaps cap the tier.** `telemetry_gap` events and checkpoint lapses are
   visible in the chain; beyond a threshold rate they cap the achievable tier
   regardless of score.
4. **Spot audits.** The control plane randomly requests raw-payload proofs
   against retained digests (see redaction model in
   [trace-model.md §3](trace-model.md)); failure to produce is an incident.
5. **Exposure weighting** (§1) already prevents score farming through
   idleness or trivial actions.

The insurer-facing report discloses attestation coverage, corroboration
coverage, and gap rate alongside the score — so a gamed number is visibly a
low-quality number (see [insurer-api.md](insurer-api.md)).
