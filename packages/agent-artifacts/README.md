# @oxagen/agent-artifacts

The one definition of what an agent, a skill, or a slash command looks like on
disk, and the one way to read, write, and hash it.

Everything that touches an artifact file goes through this package: the CLI
importer and loaders (`apps/cli`), the skill handlers (`packages/handlers`), the
skill loader (`packages/skills`), and the agent lifecycle runtime
(`packages/agent/src/runtime/lifecycle`). If two of them disagreed about the
format, an artifact would hash differently depending on who read it — so the
format lives here and nowhere else.

## What is in it

| File           | What it gives you                                                        |
| -------------- | ------------------------------------------------------------------------ |
| `schemas.ts`   | The three artifact shapes — agent, skill, command — as Zod schemas.       |
| `lifecycle.ts` | The lifecycle events, the calls an agent binds to them, and the receipt.  |
| `codec.ts`     | `parseArtifactToml` and `serializeArtifactToml`.                          |
| `hash.ts`      | `hashArtifact` (artifact identity) and `hashCanonicalJson` (value hashes).|
| `paths.ts`     | `resolveContainedPath` — proves a sidecar file stays inside the bundle.   |
| `slugs.ts`     | The two name patterns: kebab-case artifact names, snake_case capabilities.|
| `errors.ts`    | `AgentArtifactError`, with a stable `code`.                              |

## Reading and writing

```ts
import { parseArtifactToml, serializeArtifactToml, hashArtifact } from "@oxagen/agent-artifacts";

const artifact = parseArtifactToml(await readFile(path, "utf8"));
const bytes = serializeArtifactToml(artifact); // the one canonical spelling
const id = hashArtifact(artifact);             // SHA-256 of those bytes
```

`parseArtifactToml` throws `AgentArtifactError` with one of three codes:
`invalid_artifact_toml`, `unsupported_schema_version`, or `invalid_artifact`.
`serializeArtifactToml` is the exception — it throws a raw `ZodError` instead.

## Things that will bite you

- **Hashes come from bytes, not meaning.** `hashArtifact` hashes serializer
  output, so it is only as stable as `smol-toml`'s formatting. That is why the
  dependency is pinned to an exact version.
- **Map key order is part of the hash.** A skill's `metadata` and a lifecycle
  invocation's `input` are open-ended maps, and Zod keeps their keys in arrival
  order. Same pairs, different order, different hash. Build them in a fixed
  order when the hash has to be reproducible.
- **No nulls.** TOML has none. A null object value is dropped and makes the
  output unparseable; a null inside an array throws out of the serializer.
- **`resolveContainedPath` is for reads.** It returns the lexical path, not the
  resolved one, so a symlink swapped after the check is not covered. Read the
  function's own comment before using it for anything that writes.

## Adding a field

1. Add it to the right schema in `schemas.ts` or `lifecycle.ts`.
2. Bump `schema_version` only if old files stop parsing. Adding an optional
   field does not need a bump; making one required does.
3. Remember that adding a field changes what serializes, and therefore changes
   every artifact hash that uses it.
