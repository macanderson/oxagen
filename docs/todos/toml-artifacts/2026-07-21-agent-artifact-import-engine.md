# Agent Artifact Import Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Claude Code, Codex, Cursor, and legacy Oxagen agents, skill bundles, and commands into independent canonical Oxagen TOML artifacts.

**Architecture:** Platform adapters perform read-only discovery and parsing into `ImportCandidate`; shared normalization, exact tool mapping, validation, conflict resolution, staging, atomic activation, and receipts perform all writes. Foreign parsers are private to this module and never imported by normal loaders.

**Tech Stack:** TypeScript, Zod, YAML (adapter-only), `@oxagen/agent-artifacts`, Node filesystem APIs, Vitest, Commander/REPL bridge.

## Global Constraints

- Source files are untrusted and remain untouched.
- Mapping is exact and may be one-to-many; fuzzy suggestions never authorize.
- Unresolved artifacts are staged and non-executable.
- Interactive conflicts are per item; non-interactive conflicts skip by default.
- Symlinks and sidecar paths are containment-checked.
- Run only narrow tests.

---

### Task 1: Define import candidates, diagnostics, source adapters, and scan roots

**Files:**
- Create: `apps/cli/src/artifact-import/types.ts`
- Create: `apps/cli/src/artifact-import/discover.ts`
- Create: `apps/cli/src/artifact-import/discover.test.ts`
- Create: `apps/cli/src/artifact-import/adapters/{claude,codex,cursor,oxagen-legacy}.ts`
- Create co-located tests and fixtures under `apps/cli/src/artifact-import/fixtures/`.

**Interfaces:**
- `ArtifactSourceAdapter { platform; discover(options): ImportSource[]; parse(source): ImportCandidate }`
- `discoverImportCandidates(options): Promise<ImportCandidate[]>`

- [ ] Write fixture-first tests for user/workspace paths, shared `.agents/skills` dedupe by realpath+hash, broken/escaping symlinks, and one corrupt item not hiding valid siblings.
- [ ] Run `pnpm --filter @oxagen/cli test:unit -- src/artifact-import/discover.test.ts` and confirm failure.
- [ ] Implement bounded, deterministic discovery and adapter-local parsers. Copy the legacy Markdown parser into `artifact-import/adapters`; do not import it from normal loaders.
- [ ] Run all four adapter test files and confirm PASS.
- [ ] Commit with `git commit -m "feat(cli): discover foreign agent artifacts"`.

### Task 2: Build the exact tool mapping registry

**Files:**
- Create: `apps/cli/src/artifact-import/tool-mappings.ts`
- Create: `apps/cli/src/artifact-import/tool-mappings.test.ts`
- Modify: `apps/cli/src/agents/tools.ts` only to consume a shared live-catalog interface, not foreign aliases.

**Interfaces:**
- `mapForeignTools(platform, names, catalog): { mapped: string[]; unresolved: UnresolvedTool[]; mappingVersion: string }`
- Registry entry target is `readonly string[]`.

- [ ] Write tests proving Claude `Read` maps to the explicit intended read-tool set, exact Cursor terminal mapping, exact Codex identifiers, live-target validation, ambiguous MCP preservation, and no wildcard broadening.
- [ ] Confirm failure with the focused test.
- [ ] Implement a data-only versioned registry and exact MCP resolver keyed by installed server identity plus tool identity.
- [ ] Run the focused test and typecheck CLI; expect PASS.
- [ ] Commit with `git commit -m "feat(cli): map foreign tools to Oxagen identifiers"`.

### Task 3: Implement normalization, review states, and import receipts

**Files:**
- Create: `apps/cli/src/artifact-import/normalize.ts`
- Create: `apps/cli/src/artifact-import/normalize.test.ts`
- Create: `apps/cli/src/artifact-import/receipts.ts`
- Create: `apps/cli/src/artifact-import/receipts.test.ts`

- [ ] Write tests for model-alias normalization, kebab slug normalization, explicit skill references, `ready`/`needs_review`/`rejected`, stable source hashes, and unchanged re-import detection.
- [ ] Implement normalization into canonical artifact types; never write in this layer.
- [ ] Store machine-local receipts with normalized `~` paths, source/artifact hashes, mapping version, decisions, and outcome; never inject machine paths into TOML.
- [ ] Run the two focused tests; expect PASS.
- [ ] Commit with `git commit -m "feat(cli): normalize and receipt artifact imports"`.

### Task 4: Add safe staged writes and conflict decisions

**Files:**
- Create: `apps/cli/src/artifact-import/write.ts`
- Create: `apps/cli/src/artifact-import/write.test.ts`
- Create: `apps/cli/src/artifact-import/conflicts.ts`
- Create: `apps/cli/src/artifact-import/conflicts.test.ts`

- [ ] Write tests for skip default, replace, rename, no-clobber races, failure rollback, skill sidecar copy, out-of-root symlink rejection, explicit `.oxagen` symlink replacement, and regular-file independence after source mutation.
- [ ] Implement staging under the destination parent with `mkdtemp`, validate the staged bundle, then atomic rename. Never recursively delete an unresolved or broad path.
- [ ] Run focused tests; expect PASS.
- [ ] Commit with `git commit -m "feat(cli): safely activate imported artifacts"`.

### Task 5: Expose one engine through CLI and REPL

**Files:**
- Create: `apps/cli/src/artifact-import/index.ts`
- Create: `apps/cli/src/commands/import-artifacts.ts`
- Create: `apps/cli/src/commands/import-artifacts.test.ts`
- Modify: `apps/cli/src/program.tsx`
- Modify: `apps/cli/src/repl/cli-bridge.ts`
- Modify: `apps/cli/src/slash/catalog.ts`
- Modify relevant catalog/bridge tests.

- [ ] Write command tests for `--from`, `--scope`, `--dry-run`, `--json`, `--conflict`, stable exit codes, and non-interactive skip.
- [ ] Implement `oxagen import artifacts`; its handler receives an injected `ConflictResolver` so the REPL can prompt per item while headless mode stays deterministic.
- [ ] Wire `/import` through the same handler; do not create a second importer.
- [ ] Run command, catalog, and bridge test files; expect PASS.
- [ ] Commit with `git commit -m "feat(cli): add interactive artifact import"`.

### Task 6: Verify conversion fidelity and document adapters

**Files:**
- Create: `docs/guides/import-agent-artifacts.md`
- Update: `docs/reference/agent-skills.md`
- Add golden TOML outputs beside adapter fixtures.

- [ ] Add golden tests comparing every foreign fixture to exact serialized TOML.
- [ ] Document scanned locations, field losses, mapping version, unresolved review, conflicts, receipts, and symlink behavior.
- [ ] Run only `src/artifact-import/*.test.ts` plus command/catalog tests; expect PASS.
- [ ] Commit with `git commit -m "docs: document foreign artifact imports"`.
