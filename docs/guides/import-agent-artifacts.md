# Importing agent artifacts

Oxagen agents, skills, and slash commands are **TOML only**. This guide covers
`oxagen import artifacts` (and its `/import` REPL equivalent), which converts
agents, skill bundles, and commands authored for Claude Code, Codex, Cursor, or
legacy Markdown-era Oxagen into canonical Oxagen TOML.

The importer is the *only* component in the platform that reads Markdown or YAML
frontmatter. Normal loaders, scaffolds, and the runtime never do — see
[`docs/reference/agent-skills.md`](../reference/agent-skills.md) for the canonical
formats.

## What the importer guarantees

- **Source files are never modified, moved, or deleted.** Discovery and parsing
  are read-only. Your `.claude/`, `.codex/`, `.cursor/` trees are left exactly as
  they were, and remain usable by those tools.
- **Imported artifacts are Oxagen-owned and independent.** The result is a
  regular TOML file (and, for skills, a regular directory of regular files). No
  symlink back to the source survives, so later edits to the source do not
  silently change Oxagen behavior.
- **Capability mapping is exact and versioned.** Ambiguous tools are never
  guessed; they are preserved for review.
- **Activation is staged and atomic.** A partially-written artifact is never
  visible to a loader.

## Scanned locations

Scope is chosen with `--scope workspace` (default) or `--scope user`. Workspace
scope scans the current working directory; user scope scans your home directory.

| Platform | Agents | Skills (bundles) | Commands |
| --- | --- | --- | --- |
| `claude` | `.claude/agents/` | `.claude/skills/<name>/` | `.claude/commands/` |
| `codex` | `.codex/agents/`, `.agents/agents/` | `.codex/skills/<name>/`, `.agents/skills/<name>/` | `.codex/commands/`, `.agents/commands/` |
| `cursor` | `.cursor/agents/` | `.cursor/skills/<name>/` | `.cursor/commands/` |
| `oxagen-legacy` | `.oxagen/agents/` | `.oxagen/skills/<name>/` | `.oxagen/commands/` |

Under `--scope user`, each path is resolved against `$HOME` instead of the
working directory, except `oxagen-legacy`, which resolves to
`~/.config/oxagen/{agents,skills,commands}/`.

Agents and commands are flat files ending in `.md` or `.mdc` (Cursor's
extension); anything else in those directories is ignored. Skill bundles are
directories, with the manifest at `SKILL.md` or `skill.md` in the bundle root.

`.agents/skills` is shared between tools, so candidates are de-duplicated by
resolved real path and content hash — a bundle reachable from two scan roots is
imported once. A file that is not valid frontmatter, or has an empty body, is
skipped without hiding its valid siblings.

Tool grants are read from the `tools`, `allowed-tools`, or `allowed_tools`
frontmatter key, accepting either a YAML list or a comma-separated string.

Restrict discovery with `--from`:

```bash
oxagen import artifacts --from claude --from cursor
```

Point at a directory outside the standard roots with `--source`. This requires
exactly one `--from`, so the parser is unambiguous:

```bash
oxagen import artifacts --from claude --source ./vendor/claude-pack
```

## Dry run first

`--dry-run` performs full discovery, parsing, mapping, normalization, and
validation, and reports the exact outcome — but writes nothing, including no
receipt file.

```bash
oxagen import artifacts --dry-run
```

```
Would process 3 artifact(s):
✓ claude agent code-reviewer: imported
! claude agent release-captain: imported (needs review; non-executable)
– cursor skill testing: skipped
```

Add `--json` for the machine-readable receipt (the same shape written to disk on
a real run), which is the right form for CI and for diffing two runs.

## Per-item decisions and conflicts

A conflict is an existing artifact at the destination path. There are three
decisions:

| Decision | Behavior |
| --- | --- |
| `skip` | Leave the existing artifact untouched. **Default.** |
| `replace` | Atomically replace the existing artifact with the imported one. |
| `rename` | Import alongside as `<name>-imported-2` (incrementing until free). |

**Non-interactive runs default to `skip`.** Nothing is overwritten unless you say
so. Set a run-wide default with `--conflict`:

```bash
oxagen import artifacts --conflict rename
```

Decide per item with repeated `--choice <artifact>=<decision>`:

```bash
oxagen import artifacts --choice code-reviewer=replace --choice testing=skip
```

Any artifact not named in a `--choice` falls back to `skip`, so a partial
decision set can never silently overwrite an artifact you forgot to mention.

In the REPL, `/import` prompts for each conflicting item in turn and applies your
answer to that item only. CLI and REPL share one engine and one resolver seam —
there is no second importer with different behavior.

After a non-interactive run, skipped conflicts are reported with the exact
command to resolve them:

```
Choose each conflict in the REPL, then rerun:
  /import --choice code-reviewer=replace   # or skip | rename
```

## Capability mapping

Foreign tool names are mapped to canonical Oxagen capability slugs through a
data-only, versioned registry. The current mapping version is **`2026-07-21.1`**,
and it is recorded on every receipt item so a past import can be explained and
reproduced.

Mapping is **exact** and may be one-to-many. Claude's `Read`, for example, covers
capabilities that Oxagen models as four separate slugs:

| Source (`claude`) | Oxagen capabilities |
| --- | --- |
| `Read` | `read_file`, `list_dir`, `glob`, `grep` |
| `Write` | `write_file` |
| `Edit` | `edit_file` |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `Bash` | `bash` |
| `WebFetch` | `fetch_web` |
| `WebSearch` | `search_web` |

Cursor maps `Terminal` and `Shell` to `bash`, and `Read` to the same four-slug
set. Codex uses Oxagen-shaped snake_case names, which map identity-wise when the
name exists in the live capability catalog. Legacy Oxagen mirrors the Claude
table.

Mapped targets are validated against the **live** capability catalog. A mapping
whose target is not currently available does not silently disappear — it becomes
an unresolved tool with the intended targets attached as a suggestion.

No wildcard ever broadens a grant. A source tool that is not in the registry
grants nothing.

### Unresolved capabilities and `needs_review`

A tool is unresolved for one of three reasons:

| Reason | Meaning |
| --- | --- |
| `unknown_mapping` | The source name has no exact registry entry. |
| `target_unavailable` | The mapping exists but a target is not in the live catalog. |
| `ambiguous_mcp` | An `mcp__<server>__<tool>` name with no configured mapping. |

MCP tools are resolved only by installed server identity plus tool identity. A
server you do not have configured is ambiguous, never guessed.

Unresolved names are preserved verbatim in the artifact's `unresolved_tools`
array and the agent is marked **`needs_review`**. A `needs_review` agent is
written to disk, is fully inspectable, and is **excluded from execution** by the
loaders — it cannot run until a human resolves it.

To resolve one, edit the agent TOML: move each entry from `unresolved_tools` into
`tools` using the correct canonical slug, or delete it if the capability should
not be granted. Removing the last entry from `unresolved_tools` makes the agent
executable.

```toml
schema_version = 1
kind = "agent"
name = "release-captain"
description = "Runs the release checklist"
developer_instructions = "..."
tools = ["read_file", "bash"]
skills = []
unresolved_tools = ["mcp__internal__deploy"]   # ← agent will not run until this is empty
```

## Field loss and preservation

Conversion is lossy in a bounded, documented way, because the canonical schemas
are strict and closed.

**Preserved:**

- Name (normalized to a kebab-case slug), description, and body/instructions.
- Declared skill references on agents, slug-normalized.
- Every unresolved tool name, verbatim.
- Skill bundle sidecars — every regular file under the bundle root, recursively,
  is copied into the Oxagen-owned bundle. Reference paths are containment-checked
  and must stay inside the bundle.

**Normalized:**

- Names become kebab-case. A name that normalizes to nothing becomes
  `imported-artifact`.
- Model identifiers collapse to Oxagen's portable tiers: names containing
  `haiku`/`mini`/`fast` → `fast`; `opus`/`max` → `powerful`;
  `sonnet`/`balanced` → `balanced`. Anything else is carried through unchanged.
- A missing description becomes `Imported agent`/`Imported skill`/
  `Imported command`.

**Dropped:**

- Any frontmatter key with no field in the canonical schema. Nothing outside the
  schema is invented or smuggled into the TOML.
- Foreign symlinks inside a skill bundle. They are deliberately **not** carried
  into the Oxagen-owned copy, so the imported bundle has no external dependency.

Every loss and every normalization is recorded as a diagnostic on the receipt, so
"what did this import change?" is answerable after the fact without re-running it.

## Staged activation

Writes never mutate a destination in place.

1. Content is serialized with the canonical serializer, then **re-parsed** to
   prove the bytes about to be written are valid.
2. A staging directory is created with `mkdtemp` inside the *destination parent*,
   so the final step is a same-filesystem rename.
3. Files are written with `wx` (no-clobber) and mode `0600`, which makes a race
   between two concurrent importers fail loudly rather than interleave.
4. For skill bundles, sidecars are copied and the manifest written into staging;
   any existing bundle is moved aside to a backup directory, the staged bundle is
   renamed into place, and only then is the backup removed. If the rename fails,
   the backup is restored.
5. On any error the staging tree is removed. A partially-written artifact is
   never visible.

Nothing is ever recursively deleted from a broad or unresolved path — only from
paths the importer itself created.

## Symlink replacement and source preservation

`.oxagen/` paths are frequently symlinks into a foreign tool's directory, left
over from pre-TOML workflows. Import treats such a destination as a conflict with
`existingKind: "symlink"`, subject to the same decisions as any other conflict.

Choosing `replace` **replaces the symlink with a regular, Oxagen-owned file or
directory**. The symlink's *target* — the foreign source file — is not written to,
not deleted, and not followed for the write. After import, editing the foreign
source no longer changes Oxagen behavior; that independence is the point.

Choosing `skip` (the default) leaves the symlink in place.

## Receipts

Every non-dry-run import that processed at least one artifact writes a receipt:

- Workspace scope: `.oxagen/import-receipts/<timestamp>.json`
- User scope: `~/.config/oxagen/import-receipts/<timestamp>.json`

Receipts are written `wx` and `0600`, are machine-local, and are never uploaded.
Home directories are normalized to `~` and no absolute machine path is ever
written into an artifact TOML.

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-21T18:04:11.402Z",
  "scope": "workspace",
  "dryRun": false,
  "items": [
    {
      "sourcePath": "~/work/app/.claude/agents/code-reviewer.md",
      "sourceHash": "9f2b…",
      "destinationPath": "~/work/app/.oxagen/agents/code-reviewer.toml",
      "artifactHash": "1c77…",
      "platform": "claude",
      "kind": "agent",
      "name": "code-reviewer",
      "state": "ready",
      "decision": "skip",
      "outcome": "imported",
      "mappingVersion": "2026-07-21.1",
      "diagnostics": []
    }
  ]
}
```

Each item records provenance (`sourcePath`, `sourceHash`), the result
(`destinationPath`, `artifactHash`), the mapping version in force, the conflict
decision applied, the review state, the outcome, and every diagnostic. Receipts
are written for failures and skips too, not only successes — a skipped conflict
is a recorded outcome, not a silent no-op.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Run completed. Individual items may still be skipped or `needs_review`. |
| `2` | Invalid invocation — unknown platform, bad scope, bad conflict mode, malformed `--choice`, or `--source` without exactly one `--from`. |

A run that skips every conflict still exits `0`; inspect the receipt (or use
`--json`) to branch on per-item outcomes in automation.

## Recommended workflow

```bash
# 1. See exactly what would happen, and read the diagnostics.
oxagen import artifacts --dry-run --json > /tmp/import-plan.json

# 2. Import the unambiguous artifacts; conflicts skip by default.
oxagen import artifacts

# 3. Resolve conflicts deliberately, one at a time.
oxagen import artifacts --choice code-reviewer=replace

# 4. Find agents that still need a human decision on capabilities.
rg -l 'unresolved_tools = \[".+"\]' .oxagen/agents
```

Re-running import is safe: with the default `skip`, a second run over an
already-imported tree changes nothing.
