## Self-Evaluation — Budget source recovery — 2026-09-22
### What I set out to do
Recover the unfinished per-run budget fix without changing the author's worktree.
### What I actually did (measurable deltas)
Preserved the three-file patch, read the editor and commit writer, and changed the bundle reader to use the active version's definition source. Added source precedence, removal, malformed-source, legacy fallback, and signed-bundle coverage. The parent independently audited all four code files. Local suites did not run; CI is pending.
### Quality of my decisions
- Best decision: source owns removals as well as values, because the commit writer copies cached config unchanged.
- Weakest decision: I briefly shared dependency symlinks between two isolated worktrees. pnpm's automatic install changed the donor dependency tree. I replaced those symlinks with independent APFS copies.
### What I could have done better
- Read the commit writer before considering the recovered patch's config-first precedence.
- Prepare independent dependencies before the first hook invocation instead of relying on automatic installation.
### What surprised me about this codebase/product
The definition editor writes TOML while publication and older consumers also retain a separate config JSON column.
### Risks I am leaving behind
Daily budgets remain unenforced by design. The change applies only to the selected active version, not unpublished drafts. CI and a live wrapped session remain necessary verification.
### Confidence in the result: medium
Independent review accepted coverage that follows the stored source into a real signed bundle. CI has not run this commit yet.

### Review follow-up
Validated full TOML and positive safe-integer budgets before commit or publication. A persisted invalid definition now signs a suspended control bundle while evidence intake commits; a corrected definition recovers on the next poll. Added real signed-bundle refusal and ingest recovery assertions. The parent independently audited the parser, write ordering, and intake behavior before this commit. No local tests ran.
