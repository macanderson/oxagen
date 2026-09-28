# ADR-219: An existing workspace imports its .oxagen/ steering by steering PRs

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** platform, steering
- **Related:** issue #4620 (lane S10), PR #4621 (the stamp reads
  `replaces`), ADR-212 (a workspace links a code repository by a steering
  PR), ADR-198 (an agent is one operator on one runtime with one harness),
  ADR-099 (a workspace is born with its main repository), residue issue
  #4644.

## Context

A workspace created before the steering repo keeps its steering under
`.oxagen/` in a code repository. Migration 20260927185600 (ADR-212) gave that
repository's head the `steering` role. Its records are `context-record/v0.1`
TOML, and run evidence cites them by their v0.1 ids.

Provisioning binds the new steering repo with the `steering` role. Its bind
step stops with `steering_repo_already_bound` while another repository holds
that role, so provisioning cannot finish while the old head keeps it.

A steering PR merges through the stamp, which gives each changed record its
id and writes one ledger line. A record that changes its id loses its runs
unless the ledger says which id it replaces.

## Decision

1. **A workspace owner runs the import.** The capability
   `import_workspace_steering` moves one workspace. Nothing runs it on a
   schedule. Running it for every workspace is an owner step.
2. **The import runs in a fixed order.** Under `workspaceRepositoriesLock`, it
   demotes the old repository's head from `steering` to `linked`. Then it
   provisions the steering repo, opens the import steering PRs, and opens the
   cleanup pull request on the old repository. The `steering_import` workspace
   setting records each finished step, so a rerun resumes at the step that
   stopped and opens no second copy of a pull request. When provisioning
   fails before its bind step, the import gives the old head back its
   `steering` role and answers a typed error.
3. **`convertOxagenTree` converts the tree and touches nothing.** Each v0.1
   record becomes `steering/imported/<lineage>.md`, and its lineage is
   `<organization>.<workspace>.<slug>`. Each skill becomes
   `steering/skills/<lineage>/`. `steering/governance.toml` keeps the old
   mode, and a workspace with no governance file gets `team`, which is what a
   missing file meant.
4. **A person decides what the import cannot.** A v0.1 rule waits until a
   person names it a business rule or a code rule. A constraint with no
   effect waits for its effect. A record whose `record_id` is missing or is
   not a record id waits too, because its runs could not follow it. The
   import lists each of these with its reason and leaves its file in place.
5. **Import batches hold at most 299 files.** The records, skills, and
   `steering/governance.toml` go on `steering/import-oxagen`, then
   `steering/import-oxagen-2`, and so on. `workspace/import-oxagen` writes
   `workspace.toml`, which lists the old repository as a linked repository.
   Each agent gets its own `agents/<lineage>` steering PR.
6. **The stamp writes `replaces`.** Each batch commits
   `steering/imported/replaces.txt`, which names each record's old id. The
   stamp reads it from the reviewed head, writes each old id as `replaces` on
   the batch's ledger line, and deletes the file. It refuses a batch whose
   file does not read, names a path the batch does not stamp, or leaves an
   imported record without an old id. The import writes no ledger line
   itself. Each batch's PR body carries the id table, and the converter
   exports it.
7. **An agent moves only when Oxagen knows all of it.** The import writes
   `agents/<lineage>.toml` (agent/v1) only when Oxagen's agent row names its
   operator, its runtime, and its harness. The PR body lists every other
   agent under "Agents to place by hand". Agent files from before ADR-198
   have no reader, so the cleanup removes them.
8. **The cleanup removes what moved.** The cleanup pull request on the old
   repository deletes each converted file. It keeps every file the import
   left for a person, and it keeps `.oxagen/workspace.json` and the settings
   files, which belong to one checkout.

## Consequences

- Two layouts stay in force until each workspace runs the import. The readers
  of `.oxagen/` stay until then.
- The records keep their runs. The ledger line of each batch names the id
  each record replaces, so a run cited by an old id resolves to the new
  record.
- An import leaves nothing for a person to repair by hand in the ledger. What
  it cannot convert stays in the old repository, listed with its reason.
- Two gaps stay open in #4644. The stamp accepts one old id for two records,
  and an import branch skips the one-change rule for every steering path.
- The import is one synchronous call. The `steering_import` setting also
  serves as a lease: a run holds the workspace for ten minutes after its last
  save, and a second call in that window gets `steering_import_running`. A
  call after the lease lapses resumes the run that stopped.
- The import reads GitHub only. It refuses a workspace steered from GitLab
  (`steering_import_provider_unsupported`) and a repository Oxagen can no
  longer reach (`steering_import_source_unreachable`). It also refuses a
  repository the workspace reads through a sources connection with no binding
  (`steering_import_legacy_connection`). The owner binds that repository
  first.
- When a rule needs a kind or a constraint needs an effect, the import answers
  `needs_choices` and changes nothing. The owner runs it again with
  `ruleKinds` and `constraintEffects`.
- Oxagen's agent registry records no operator yet. Until it does, the import
  writes no agent file, and the first steering PR lists every agent under
  "Agents to place by hand".
- A rerun finds a pull request it opened but did not save by looking for the
  open pull request on its branch. If a person closes that pull request
  before the rerun, the rerun opens a new one.
