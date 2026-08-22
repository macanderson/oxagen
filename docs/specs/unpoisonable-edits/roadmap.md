# Un-poisonable Edits — Feature Roadmap

**Status:** V1 shipped (this PR) · roadmap phases V1.1 → V4 below
**Owner surface:** `packages/agent-engine` (tool layer), every agent surface inherits it
**Vision anchor:** `docs/VISION.md` — the typed-contract wedge applied to the file system:
identity → permitted action → verified outcome → audit record, **per edit**.

## Why this feature exists

Torn and misapplied patches are still the #1 silent killer of agent accuracy. An agent
reads a file, another session (or its own earlier bash command) changes it, and the next
`edit_file` lands in the wrong place or clobbers someone else's work. Worse, an edit can
land *cleanly* and still poison the file — a broken JSX tag, a mangled import — and the
damage is only discovered N turns later by a failing build, after the agent has stacked
more work on top of it. Both failure classes are structural, so the defense must be
structural too: not a prompt asking the model to be careful, but a harness that makes the
bad write impossible.

This is also the product wedge in miniature. Oxagen's positioning is the one enforced
object binding identity → knowledge scope → permitted action → commercial terms →
verified outcome → audit record. V1 applies the last three links to every file mutation;
the later phases add the first three.

## What we have today (V1 — this PR)

Single enforcement point in `buildWorkspaceTools` (`packages/agent-engine/src/tools.ts`),
the same seam the graph-backed file lock uses, so chat, fleet dispatch, and sandboxed
runs all inherit it with zero per-surface wiring:

1. **Hash anchoring (stale-read rejection).** Every whole-file `read_file` records a
   sha256 content anchor in a per-run ledger. `edit_file`/`write_file` compare the anchor
   against the file's current on-disk hash; a mismatch means the file changed since the
   agent last saw it, and the mutation is rejected with a re-read instruction instead of
   being misapplied. Successful mutations re-anchor, so edit chains stay valid without
   re-reads.
2. **Syntax gate (AST-level, pre-write).** For TS/TSX/JS/JSX/JSON the harness parses the
   candidate content *before* writing. An edit that introduces new syntax errors relative
   to the file's prior state is rejected and the errors are returned to the model. Files
   that were already broken are not re-punished — only *new* damage gates.
3. **Declared breakage escape hatch.** `expect_errors: true` lets the agent say "this
   will break until step 4." The write proceeds and the declaration is recorded — visible
   intent instead of silent damage.
4. **Diagnostics port.** A `DiagnosticsProvider` seam (`ports.ts`) so a surface can plug
   a real project-wide typechecker into the same before/after delta gate. V1 ships the
   port; the built-in single-file syntax check is the default provider.
5. **Audit trail.** Every `file-edit` event now carries `beforeHash → afterHash`, the
   diagnostic delta, the declared-breaking flag, and the replacement count — the raw
   material for per-edit lineage.

## Roadmap

### V1.1 — Project-wide typecheck delta (target: +2 weeks)
Ship a real `DiagnosticsProvider` backed by an incremental TypeScript language service
(tsserver / `ts.createLanguageService` with a document registry), scoped to the edited
file's package. The gate then catches type damage, not just syntax damage: a renamed
export that breaks three importers is rejected (or declared) at write time.
- Debounced, budgeted: single-file check is synchronous; cross-file check runs within a
  latency budget (~500ms) and degrades to advisory when exceeded.
- The local runner wires it first (tsserver already warm from the code graph); the sandbox runner second.
- **Acceptance:** an edit that breaks a sibling file's types is rejected with the sibling's
  diagnostic quoted; p95 edit latency overhead < 700ms.

### V2 — AST-applied transforms (target: +1 quarter)
Add first-class structural edit operations alongside string replacement: `rename_symbol`,
`add_import`, `update_signature`, `wrap_node` — applied via the TypeScript AST (ts-morph
or compiler transforms), so whitespace and formatting drift cannot misplace them at all.
String edits stay for prose/config; structural edits become the preferred tool for code.
- Anchors become node anchors (file hash + AST path + node text hash) — stable under
  reformatting.
- **Acceptance:** rename across a file survives an interleaved prettier run that would
  have invalidated every string anchor.

### V2.2 — Lineage graph edges per edit (target: +1 quarter, parallel with V2)
Land every gated edit in Neo4j: `(:Edit {beforeHash, afterHash, delta, declared})-
[:PRODUCED_BY]->(:Turn)-[:OF_EXECUTION]->(:Execution)`, wired through the existing
execution-lineage contracts (same channel as `agent.subagent.dispatch` lineage). The
audit record becomes queryable: "which turn broke this file, and did it declare it?"
- ClickHouse keeps the high-volume event stream; Neo4j gets the relationship edges
  (four-store boundaries respected).
- **Acceptance:** `ontology.neighbors` on a file node returns its edit history with turns.

### V3 — Cross-language gates (target: +2 quarters)
tree-sitter grammars extend the syntax gate to Python, Go, Rust, SQL, YAML; per-language
diagnostic providers (ruff/pyright, gopls) plug the same `DiagnosticsProvider` port.
- **Acceptance:** the same stale-anchor + syntax-delta behavior demonstrated in a Python
  sandbox template.

### V4 — Edit as a capability contract (target: 2 quarters+)
Promote the mutation itself to a metered, IAM-gated capability (`edit_apply`): the full
chain identity → knowledge scope → permitted action → commercial terms → verified outcome
→ audit record, per edit. Fleet operators can scope *which paths an agent may mutate*
(permitted action), price mutation classes (commercial terms), and resell governed edit
capacity. This is the Stripe-for-agents wedge on the file system, and the reason V1 was
built at the single enforcement seam every surface shares.
- **Acceptance:** an org policy denying `packages/billing/**` mutations to a contractor
  agent is enforced at the tool layer and visible in the audit trail.

## Success metrics

- Misapplied/torn patch incidents per 1k agent edits (target: 0 structural, measured via
  stale-anchor rejections that would previously have been silent misapplies).
- New-diagnostic escapes per 1k edits (edits that landed damage without declaration).
- Median re-read recovery: one turn (the rejection message is corrective, not fatal).
- Latency overhead per edit: p50 < 30ms (V1 syntax gate), p95 < 700ms (V1.1 typecheck).

## Risks and mitigations

- **False-positive rejections stall loops** → gates only fire on *new* damage; rejection
  messages are corrective (they say exactly what to do next); `expect_errors` is always
  available and audited.
- **Latency on remote workspaces** (extra full read per edit) → the read feeds three
  gates at once (stale check, syntax before-state, event enrichment); V1.1 adds content
  caching keyed by the ledger hash.
- **Model confusion about the new rejection class** → rejection strings follow the
  existing corrective-feedback voice of `describeEditFailure`, which the models already
  handle well.
