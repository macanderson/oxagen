## Self-Evaluation: audit detail, 2026-09-20
### What I set out to do
Expose stored approval-rule invalidation evidence through audit reads and signed exports.
### What I actually did (measurable deltas)
Added the nullable optional detail contract, shared database selection, CSV and NDJSON serialization, documentation, and query/export witnesses. Generated the contract schema.
### Quality of my decisions
- Kept the existing org fence and tested the registered handlers instead of only the serializer.
- Preserved absent legacy detail while making new reads return null explicitly.
### What I could have done better
- Read the schema generator dependency resolution before trying to execute it in a fresh worktree.
- Check pnpm's implicit-install default before linking shared dependencies for hooks.
### What surprised me about this codebase/product
The audit record already persisted invalidation facts but neither supported read exposed them.
### Risks I am leaving behind
CI owns full execution under the shared-machine verification policy.
### Confidence in the result
Medium: independent coverage audit approved the diff, with runtime verification pending CI.
