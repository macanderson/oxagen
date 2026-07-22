# TOML Artifacts and Hard Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one shared TOML artifact format and move every normal Oxagen agent, skill, and slash-command path off Markdown frontmatter.

**Architecture:** A new dependency-light `@oxagen/agent-artifacts` package owns strict schemas, parsing, deterministic serialization, path containment, and hashing. Filesystem TOML is canonical locally; managed immutable TOML versions are canonical in Postgres and indexed columns are transactional projections. Runtime loaders accept TOML only; legacy parsing is owned exclusively by Track 2's importer.

**Tech Stack:** TypeScript 6, Zod 3, `smol-toml` 1.7, `canonical-json` 0.4, Vitest, pnpm workspace.

## Global Constraints

- TOML is the only normal executable manifest format.
- Skill bundles remain directories with `skill.toml` plus contained sidecars.
- Normal loaders never scan Claude, Codex, Cursor, or legacy Markdown paths.
- Artifact names are kebab-case; capability names remain ADR-025 verb-first snake_case.
- Run only narrow tests named by each task; never run the full suite mid-task.
- Track 2's converter must be available before Task 4 performs repository-owned conversion.

---

### Task 1: Create the canonical artifact package

**Files:**
- Create: `packages/agent-artifacts/package.json`
- Create: `packages/agent-artifacts/tsconfig.json`
- Create: `packages/agent-artifacts/vitest.config.ts`
- Create: `packages/agent-artifacts/src/schemas.ts`
- Create: `packages/agent-artifacts/src/types.ts`
- Create: `packages/agent-artifacts/src/index.ts`
- Test: `packages/agent-artifacts/src/schemas.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `artifactSchema`, `agentArtifactSchema`, `skillArtifactSchema`, `commandArtifactSchema`, `Artifact`, `AgentArtifact`, `SkillArtifact`, `CommandArtifact`.
- Consumes: no Oxagen workspace package; this package must remain a leaf.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { agentArtifactSchema, skillArtifactSchema } from "./schemas";

it("preserves unresolved tools for needs-review classification", () => {
  const result = agentArtifactSchema.safeParse({
    schema_version: 1, kind: "agent", name: "reviewer",
    description: "Reviews code", developer_instructions: "Review.",
    tools: [], skills: [], unresolved_tools: ["Task"],
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.unresolved_tools).toEqual(["Task"]);
});

it("requires explicit contained skill references", () => {
  expect(() => skillArtifactSchema.parse({
    schema_version: 1, kind: "skill", name: "review",
    description: "Review code", instructions: "Review.", references: ["../x"],
  })).toThrow();
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm --filter @oxagen/agent-artifacts test:unit -- schemas.test.ts`
Expected: FAIL because the package and schemas do not exist.

- [ ] **Step 3: Implement strict discriminated schemas**

Use `z.discriminatedUnion("kind", [...])`, literal `schema_version: 1`, `.strict()` objects, kebab-case names, explicit defaults only where serialization remains deterministic, and the lifecycle types imported later by Track 3 through an additive module.

- [ ] **Step 4: Install pinned parser/hash dependencies**

Run: `pnpm --filter @oxagen/agent-artifacts add smol-toml@1.7.0 canonical-json@0.4.0`
Expected: package manifest and lockfile update without unrelated version churn.

- [ ] **Step 5: Run the focused test**

Run: `pnpm --filter @oxagen/agent-artifacts test:unit -- schemas.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-artifacts pnpm-lock.yaml
git commit -m "feat(agent-artifacts): add canonical TOML schemas"
```

### Task 2: Add deterministic parse, serialize, hashing, and safe paths

**Files:**
- Create: `packages/agent-artifacts/src/codec.ts`
- Create: `packages/agent-artifacts/src/hash.ts`
- Create: `packages/agent-artifacts/src/paths.ts`
- Test: `packages/agent-artifacts/src/codec.test.ts`
- Test: `packages/agent-artifacts/src/hash.test.ts`
- Test: `packages/agent-artifacts/src/paths.test.ts`
- Modify: `packages/agent-artifacts/src/index.ts`

**Interfaces:**
- Produces: `parseArtifactToml(raw): Artifact`, `serializeArtifactToml(value): string`, `hashArtifact(value): string`, `hashCanonicalJson(value): string`, `resolveContainedPath(ownerFile, relativePath): string`.

- [ ] **Step 1: Write failing round-trip and containment tests**

Assert LF-normalized deterministic output, stable hashes across object-key order, rejection of `undefined`/cycles/non-finite numbers, and rejection of absolute, `..`, and out-of-root symlink targets.

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @oxagen/agent-artifacts test:unit -- codec.test.ts hash.test.ts paths.test.ts`
Expected: FAIL with missing exports.

- [ ] **Step 3: Implement the codec**

Parse with `smol-toml`, validate through `artifactSchema`, serialize fields in schema-owned order, normalize to one trailing newline, hash artifact UTF-8 bytes with SHA-256, and hash structured values through RFC 8785 canonical JSON.

- [ ] **Step 4: Implement path containment**

Resolve from the owning TOML directory, reject non-relative inputs, compare `realpath` containment for existing files, and return typed `invalid_reference_path` errors.

- [ ] **Step 5: Verify passing tests and types**

Run: `pnpm --filter @oxagen/agent-artifacts test:unit -- codec.test.ts hash.test.ts paths.test.ts`
Expected: PASS.

Run: `pnpm --filter @oxagen/agent-artifacts typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-artifacts
git commit -m "feat(agent-artifacts): add deterministic TOML codec"
```

### Task 3: Switch CLI agents, skills, and commands to TOML only

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/agents/{loader,types,write}.ts`
- Modify: `apps/cli/src/agents/__tests__/loader.test.ts`
- Modify: `apps/cli/src/skills/{loader,types,write}.ts`
- Modify: `apps/cli/src/skills/__tests__/loader.test.ts`
- Modify: `apps/cli/src/slash/{loader,types,write}.ts`
- Modify: `apps/cli/src/slash/__tests__/loader.test.ts`
- Modify: `apps/cli/src/config/indexer.ts`
- Modify: `apps/cli/src/config/__tests__/indexer.test.ts`
- Modify: `apps/cli/src/program.tsx`
- Leave for out-of-scope rules/prompts: `apps/cli/src/lib/markdown-registry.ts`; agent artifact loaders must stop importing it, while Track 2 owns private legacy artifact parsing.

**Interfaces:**
- Consumes: `parseArtifactToml`, canonical artifact types.
- Produces: the existing `loadAgents`, `loadSkills`, `loadCommands` APIs with TOML-backed values and no foreign-directory discovery.

- [ ] **Step 1: Replace loader fixtures with TOML and add negative Markdown cases**

Each loader test must prove canonical TOML loads, precedence remains user then workspace, unresolved agents are excluded with diagnostics, and `.md`/`SKILL.md` plus `.claude`/`.cursor` files are ignored.

- [ ] **Step 2: Verify the three loader tests fail**

Run: `pnpm --filter @oxagen/cli test:unit -- src/agents/__tests__/loader.test.ts src/skills/__tests__/loader.test.ts src/slash/__tests__/loader.test.ts`
Expected: FAIL because loaders still read Markdown.

- [ ] **Step 3: Implement TOML-only discovery and scaffolds**

Agents scan `agents/*.toml`; skills scan `skills/*/skill.toml`; commands scan `commands/*.toml`. Writers call the shared serializer and use `wx`/no-clobber behavior. Update help text to the new paths.

- [ ] **Step 4: Update config indexing**

Index canonical TOML only for active Oxagen artifacts. Foreign discovery moves to Track 2 and must not leak back into normal configuration resolution.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2 plus `pnpm --filter @oxagen/cli test:unit -- src/config/__tests__/indexer.test.ts`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli pnpm-lock.yaml
git commit -m "feat(cli): load agent artifacts from TOML only"
```

### Task 4: Convert and embed bundled skills through the importer

**Prerequisite:** Track 2 Tasks 1-4 are complete.

**Files:**
- Replace: `packages/skills/skills/*.skill.md` with `packages/skills/skills/<slug>/skill.toml`
- Modify: `packages/skills/src/{types,loader,filesystem,builtin,builtin-codegen}.ts`
- Modify: `packages/skills/scripts/embed-skills.ts`
- Regenerate: `packages/skills/src/builtin-skills.generated.ts`
- Modify tests adjacent to those files.
- Modify: `packages/skills/package.json` (remove `yaml`, add `@oxagen/agent-artifacts`)

- [ ] **Step 1: Add failing TOML bundle discovery and generated-data tests**

Assert recursive `skill.toml` discovery, explicit references, corrupt TOML isolation, and generated source equality.

- [ ] **Step 2: Convert repository skills with the production converter**

Run: `pnpm --filter @oxagen/cli exec oxagen import artifacts --from oxagen-legacy --scope workspace --source packages/skills/skills --conflict overwrite`
Expected: one ready TOML bundle per existing skill, zero unresolved tools, originals untouched until reviewed.

- [ ] **Step 3: Switch package loaders/codegen, then remove legacy files**

Use `@oxagen/agent-artifacts`; explicit references replace heading scraping. Remove YAML only after all converted bundles pass.

- [ ] **Step 4: Regenerate and verify**

Run: `pnpm --filter @oxagen/skills gen:skills`

Run: `pnpm --filter @oxagen/skills test:unit -- loader.test.ts filesystem.test.ts builtin.generated.test.ts create-agent-skill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills pnpm-lock.yaml
git commit -m "feat(skills): convert bundled skills to TOML"
```

### Task 5: Cut workspace skill APIs and immutable versions over to TOML

**Files:**
- Modify: `packages/handlers/src/skill-{synthesis,version-create,workspace-seed}.ts`
- Modify: `packages/handlers/src/skill.{author,draft,edit,export,revise,version.get,version.upload,workspace.install}.ts`
- Modify their co-located tests.
- Modify matching contracts under `packages/oxagen/src/contracts/skill.*.ts` and tests.
- Modify matching API routes under `apps/api/src/routes/v1/skill.*.ts` and MCP tools under `apps/mcp/src/tools/skill.*.ts`.

**Interfaces:**
- Canonical request/response field: `content` containing TOML.
- Parsed projection: `artifact`, never `frontmatter`.
- Export filename: `<slug>.toml`.

- [ ] **Step 1: Change contract tests first**

Replace `skillMd`/frontmatter fixtures with canonical TOML and assert `.toml` downloads and parsed `artifact` projections.

- [ ] **Step 2: Verify focused failures**

Run: `pnpm --filter @oxagen/oxagen test:unit -- skill.create.test.ts skill.draft.test.ts skill.export.test.ts skill.version.get.test.ts skill.version.upload.test.ts`
Expected: FAIL on old field names and filenames.

- [ ] **Step 3: Implement handler cutover transactionally**

Validate TOML before any write. Persist the immutable TOML source and relational projections in one `withTenantDb` transaction. Synthesis returns structured fields, then the shared serializer creates canonical content.

- [ ] **Step 4: Run focused contract and handler tests**

Run the Step 2 command and the corresponding `@oxagen/handlers` test files.
Expected: PASS.

- [ ] **Step 5: Run parity checks**

Run: `pnpm check:contracts`

Run: `pnpm check:manifest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/handlers packages/oxagen apps/api apps/mcp
git commit -m "feat(skills): make workspace skill versions TOML canonical"
```

### Task 6: Remove active Markdown assumptions and document the cutover

**Files:**
- Modify: `docs/reference/agent-skills.md`
- Modify: `packages/skills/README.md`
- Modify capability docs under `docs/capabilities/skill*.md`
- Modify relevant inventory specs under `docs/specs/inventory/`
- Create: `docs/guides/import-agent-artifacts.md`
- Modify generated documentation indexes as required by repo tooling.

- [ ] **Step 1: Add a static regression check**

Extend the appropriate contract/manifest script to fail when normal loader code or live capability docs contain `.skill.md`, `SKILL.md`, `skillMd`, or "YAML frontmatter" outside importer adapters and historical migration docs.

- [ ] **Step 2: Update documentation and examples**

Document the three TOML schemas, explicit skill references, `/import`, hard-cutover behavior, and legacy diagnostic path.

- [ ] **Step 3: Run focused verification**

Run: `pnpm --filter @oxagen/agent-artifacts test:unit`

Run: `pnpm --filter @oxagen/skills test:unit -- loader.test.ts filesystem.test.ts builtin.generated.test.ts`

Run: `pnpm --filter @oxagen/cli test:unit -- src/agents/__tests__/loader.test.ts src/skills/__tests__/loader.test.ts src/slash/__tests__/loader.test.ts src/config/__tests__/indexer.test.ts`

Run: `pnpm check:contracts`
Expected: PASS.

Run: `pnpm check:manifest`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs packages/skills tools
git commit -m "docs: document TOML agent artifact cutover"
```
