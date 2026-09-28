# ADR-214: Generated files commit no value derived from the whole set

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** ci, database
- **Related:** issue #3691 (generated manifests conflict between capability
  branches), issue #3148 (fail CI when capability schemas drift), #3233 (a
  merged manifest whose hash matched neither side), ADR-031 (the storage
  manifest; this record amends its manifest shape), ADR-110 (a bad
  integration resolution is what review misses).

## Context

Three committed, generated files each held a value computed from the whole
capability or table set:

| File | The shared cell |
| --- | --- |
| `packages/database/storage-manifest.json` | `contentHash`, a sha256 over the manifest body, and `tableCount` on each store |
| `docs/capabilities/schemas/_index.json` | `generatedCount` |
| `docs/capabilities/schemas/README.md` | `**N capabilities** across M domains.`, and one `- **domain** (N): a, b, c` line per domain |

Every branch that adds a capability or a table rewrites those lines. Two such
branches therefore conflict by construction, and every merge to `main`
re-conflicts each open branch that carries one. On 2026-09-21 one sweep saw
#3622, #3632, and #3645 conflict on all three files at once, and then #3626,
#3632, and #3650 re-conflict on `contentHash` alone after three other PRs
merged.

The right resolution is to regenerate from the merged tree, because neither
side's value describes the merge. Keeping one side merges clean and leaves a
file that disagrees with the content it covers. #3233 did exactly that: it
merged a manifest of 319 capabilities with a `contentHash` that was the hash
of neither that body nor the one before it.

The issue offered three options: a git merge driver that regenerates each
file, dropping the derived values from the committed files, or keeping them
and adding a check that recomputes them.

## Decision

1. **The storage manifest commits no `contentHash` and no `tableCount`.**
   The generator stops writing both, and `MANIFEST_VERSION` moves to 2.
   `contentHashOf(manifest)` computes the hash wherever it is read, and it
   equals the sha256 of the committed file's bytes. `manifestSummary` counts
   each store's tables from the `tables` array. The architecture atlas
   derives both when it reads the file. This amends the manifest shape in
   ADR-031. The `version`, `stores`, `domains`, `tables`, and `capabilities`
   members are unchanged.
2. **`_index.json` commits no `generatedCount`.** A reader who wants the
   count takes `capabilities.length`. This changes a published format, and
   no reader in this repository used the field.
3. **The schema `README.md` commits no count and no joined list.** It lists
   one capability per line under a `## <domain>` heading. Two branches that
   add capabilities, even to the same domain, then touch different lines.
4. **Each drift check names the file and both values.** `pnpm docs:schemas
   --check` prints each stale file with its first differing line, committed
   and regenerated. `pnpm schema:manifest:check` prints the content hash of
   each side, the first differing line with both values, and says when a
   file still records a field this record retired. A wrong merge resolution
   is therefore loud, and the report says what it was.
5. **`atlas.sum` is excluded.** Atlas owns the format. Its first line hashes
   the whole migration directory, so it is a shared cell that no change on
   the Oxagen side can remove, and Atlas refuses to apply a directory whose
   sum does not match. The resolution after a merge is to run `atlas migrate
   hash --dir "file://atlas/migrations"` from `packages/database` on the
   merged tree. Two checks already fail a wrong resolution in CI: the
   `atlas-validate` job runs `atlas migrate validate`, which checks the
   directory hash, and `pnpm db:lint-migrations` fails a missing, duplicate,
   or spliced entry with a message that names `atlas migrate hash`.
6. **`AGENTS.md` names every shared cell.** Its Git Workflow section lists
   the files every PR of a shape must write, with the rule to regenerate
   from the merged tree and never keep one side.

## Alternatives considered

- **A merge driver per file.** A `.gitattributes` entry and a driver that
  regenerates the file would remove the conflict for all four files,
  `atlas.sum` included. It needs the generator to run inside `git merge`,
  which means installed dependencies and, for `atlas.sum`, the Atlas CLI.
  GitHub's server-side merge runs no custom driver, so a PR would still show
  as conflicting there, and a checkout without dependencies would fail or
  fall back to a text merge. It also hides the regeneration from the person
  merging, which is the step ADR-110 found gets missed.
- **Keep the values and add a recompute check.** This makes a wrong
  resolution loud but keeps the conflict on every capability-adding PR, and
  each conflict costs a full required CI run. The check has value, so
  decision 4 keeps it in the form of the drift reports.

## Consequences

- Two branches that each add a capability or a table merge without a
  conflict in these three files, unless their new entries sort next to each
  other in the same array. That conflict sits on real content, and taking
  both sides is the correct resolution. `tools/scripts/lib/capability-schema-docs.test.ts`
  and `packages/database/src/storage-manifest/merge.test.ts` prove the clean
  merge with `git merge` in a temporary repository, byte-equal to
  regenerating the merged sources. Each has a control that restores the old
  fields and shows the same branches conflicting.
- ADR-031's proposed Phase 2 projector and Phase 3 tier-0 index key on the
  content hash. They compute it with `contentHashOf` instead of reading a
  field.
- A branch cut before this change that merges after it conflicts on the
  removed lines once. Regenerating resolves it, and the drift check names a
  resolution that kept `contentHash` or `tableCount`.
- `atlas.sum`, `pnpm-lock.yaml`, `Cargo.lock`,
  `packages/oxagen/capabilities.manifest.json`,
  `apps/app/src/i18n/messages.d.ts`, and ADR numbers remain shared cells.
  `AGENTS.md` names them so an author meets the hazard before the conflict.
