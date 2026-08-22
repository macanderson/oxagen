/* Presenter script for the Un-poisonable Edits feature briefing deck.
 * Consumed by the deck engine's teleprompter (press S). One entry per slide,
 * in slide order. `say` is the spoken line. */
window.OX_SCRIPT = [
  {
    title: "Un-poisonable edits · title",
    say: "This briefing covers a harness feature we shipped today. The short version: an Oxagen agent can no longer silently misapply an edit or silently break a file. Every edit is anchored to a content hash, parsed before it lands, and recorded with a verifiable before and after anchor. I'll show what shipped, where it goes, and why we think it's the wedge in miniature.",
  },
  {
    title: "The problem",
    say: "Agent edits fail in two quiet ways. Torn patches: the file changed between the agent's read and its edit, so the patch lands on the wrong version. And silent damage: the edit applies cleanly but breaks the syntax, and nobody notices until a build fails many turns later. On a tree where multiple sessions work in parallel, both are routine. And afterwards nothing records who broke what. These are structural failures, so the fix has to be structural.",
  },
  {
    title: "Shipped today · hash anchors",
    say: "First gate: hash anchoring. Every whole-file read records a sha256 anchor in a per-run ledger. Before any mutation, the harness re-hashes the file on disk. If the hashes disagree, the world moved, and the edit is refused with a corrective message instead of being misapplied. One re-read recovers. Successful edits re-anchor, so chains of edits stay cheap. And the model never manages any of this; it's harness state.",
  },
  {
    title: "Shipped today · syntax gate",
    say: "Second gate: before a write touches disk, we parse the candidate content. TypeScript, TSX, JavaScript, JSON. An edit that would introduce new syntax errors is rejected with the exact diagnostics quoted back. Note the word new: a file that was already broken is not re-punished. And when breakage is intentional, mid-refactor, the agent declares it with expect underscore errors, the write proceeds, and the declaration is recorded. Declared, not silent.",
  },
  {
    title: "Shipped today · one seam",
    say: "Third: where it lives. All of this is enforced at the single tool layer every agent run shares, the same seam as our graph-backed file locks. Chat, API runs, fleet workers, sandboxed runs: all inherit it with zero per-surface wiring, and none can opt out. We also shipped a diagnostics provider port, which is the seam a full project typechecker plugs into next.",
  },
  {
    title: "The audit trail",
    say: "Every mutation event now carries before and after hashes, the diagnostic delta, the declared-breaking flag, and the replacement count. That's the accountability chain applied per edit: identity, permitted action, verified outcome, audit record. It's also the raw material for the lineage graph phase of the roadmap.",
  },
  {
    title: "Roadmap",
    say: "Where it goes. In weeks: a real typecheck delta, so an edit that breaks a sibling file's types is refused at write time. Next quarter: AST transforms, where anchors attach to syntax nodes and survive reformatting entirely, plus lineage edges in Neo4j so edit history becomes queryable. Then cross-language gates through tree-sitter. And the destination: the edit itself as a metered, IAM-gated capability contract. Scope which paths an agent may touch, price mutation classes, resell governed edit capacity.",
  },
  {
    title: "Why it matters",
    say: "Why this is important. The frontier models converged; the harness is now the differentiator. Accuracy is a property of the loop. Refusing the bad write beats repairing it, every time, and that's the accuracy moat. The per-edit audit chain is the trust moat: enterprises can prove what their agents did. Hash anchoring exists elsewhere; the delta gate and the lineage record don't. This is our typed-contract wedge applied to the file system itself.",
  },
  {
    title: "The close",
    say: "So: torn patches, structurally impossible. Shipped today at one seam for every surface. Typecheck deltas, AST transforms, lineage, and governed billable edits on the way. The platforms that win the agent era are the ones whose loops cannot silently damage your code, and can prove it.",
  },
];
