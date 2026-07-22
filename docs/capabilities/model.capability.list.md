# model.capability.list

**Capability name:** `list_model_capabilities`
**Domain:** model
**Mode:** sync
**Scope:** unscoped (platform metadata, not tenant data)
**Surfaces:** api, mcp, agent, cli
**Risk level:** low

## Intent

List the **provider capability posture matrix** — the typed, per-vendor feature
matrix in `@oxagen/ai`'s `provider-posture.ts` that declares, for every vendor
the Vercel AI Gateway can route to, how its prompt cache is engaged, how its
reasoning budget is controlled, how schema-constrained output is obtained, and
which attachment kinds it accepts. Oxagen is BYOK and vendor-neutral, so a
caller routing work to a customer-configured provider needs to know what that
provider *actually* supports before dispatching — this capability turns that
knowledge from adapter folklore into something queryable over every surface.

### The four axes

| Axis | What it answers |
|---|---|
| `cache` | Is the prompt cache explicit **opt-in** (a marker the caller must send) or **implicit** (the vendor caches automatically and reports hits on its usage envelope)? |
| `reasoning` | Is the reasoning/thinking budget **controllable** from the request, **fixed-on/off**, or **unsupported** (the vendor reasons but exposes no request-level control)? |
| `structuredOutput` | Is schema-constrained JSON **native** (the gateway drives real constrained decoding) or **emulated** (prompt-directed JSON plus a parse/retry loop, so malformed output is possible)? |
| `attachments` | Which non-text input parts (`image`, `video`, `audio`) does the vendor accept, or is it **text-only** / not applicable? |

Every axis that carries a mechanism also carries `not-applicable` for
image-generation-only vendors (`bfl`/FLUX has no chat path, no cache, no
reasoning phase, and no attachment input) — the matrix reports these as honest
n/a rows rather than implying a "yes" by omission.

### The motivating defect

This registry exists because of a real, silent billing bug. Anthropic's
prompt cache is **explicit opt-in**: nothing is cached unless the request
carries a `cacheControl: {type: "ephemeral"}` marker on the relevant message.
OpenAI, Gemini, and DeepSeek all cache **implicitly** — no marker required,
hits just show up in usage telemetry. Nothing enforced that divergence, so a
gateway-routed Claude call that never set the marker ran at a **silent 0%
cache-hit rate**, billing every input token at the full, uncached rate on
every single turn of a multi-turn conversation — no error, no warning, just a
quietly larger invoice. `docs/capabilities/model.capability.list.md` (this
capability) and the underlying registry make that class of gap structural:
every vendor the gateway can route to must declare a row on every axis, or the
package's own test suite fails at build time, not in a customer's bill.

### Witness-test enforcement, in both directions

Declaring a posture in prose is not proof it holds. Every variant that claims
a specific mechanism (`opt-in`, `implicit`, `controllable`, `native`,
`emulated`, `supported`) carries a `witness`: the exact title of a test that
proves the behavior — the opt-in marker reaches the wire, the hit telemetry is
parsed and metered, the reasoning control lands in the request body, the
schema reaches `generateObject` and the output parses. `packages/ai/src/provider-posture.test.ts` enforces this from both ends:

- **Forward gate (completeness):** every vendor in the `Vendor` union
  (`packages/ai/src/catalog.ts`) must have a row on all four axes — a new
  vendor added to the catalog without a matching posture row is a **TypeScript
  compile error** (each matrix is `Record<Vendor, …>`), and the test suite
  double-checks it at runtime against the live catalog.
- **Reverse gate (witness integrity):** every named witness must exist,
  verbatim, in one of the declared `WITNESS_SOURCES` test files
  (`stream.test.ts`, `catalog.test.ts`, `generate-object.test.ts`), read from
  disk at test time. A witness whose test was renamed or deleted fails loudly
  — without this direction the matrix could decay into confident-sounding
  claims backed by proof that no longer exists, which is worse than no matrix
  at all.

No-control variants (`not-applicable`, `fixed-on`, `fixed-off`, `unsupported`,
`text-only`) carry a `reason`/`note` instead of a witness — a reviewer can
check those by reading the adapter code, since there is no positive behavior
to assert a test against.

## Input

| Field | Type | Notes |
|---|---|---|
| `vendor` | `string` (optional) | Filter to one vendor by its gateway creator prefix (e.g. `"anthropic"`). Omit for the full matrix. |
| `model` | `string` (optional) | Resolve the posture that applies to a specific gateway model id (e.g. `"anthropic/claude-sonnet-5"`). Takes precedence over `vendor` when both are supplied. |

## Output

| Field | Type | Notes |
|---|---|---|
| `vendors` | `VendorPosture[]` | Zero rows when the filter matched nothing, one row for a `vendor`/`model` filter, all 8 rows (alphabetical) with no filter. |
| `unknownFilter` | `string \| null` | The `vendor`/`model` value that matched no posture row, or `null` when the filter resolved (or none was supplied). Lets a caller distinguish "no posture declared" from "empty matrix" — **an unknown provider must read as unknown, never as supported.** |

Each `VendorPosture`: `{ vendor, label, models, cache, reasoning,
structuredOutput, attachments }`, where `models` is the list of catalog
gateway model ids that vendor ships (e.g. `["anthropic/claude-opus-4.8",
"anthropic/claude-sonnet-5", …]`), and each axis field is the full discriminated
union documented above — `kind` plus that variant's `mechanism`/`telemetry`/
`note`/`reason` and (where present) `witness`.

## Side effects

None. The underlying registry is a static, compile-time-complete TypeScript
module — the handler does no I/O, so there is nothing to fail beyond a bad
input shape.

## Surfaces

- **API:** `GET /v1/model/capabilities` — `?vendor=` or `?model=` query params, both optional
- **MCP:** `list_model_capabilities` tool (idempotent, read-only)
- **Agent:** `invoke("list_model_capabilities", { vendor?, model? })` — no approval required, risk `low`
- **CLI:** `oxagen models capabilities [--vendor <vendor>] [--model <gateway-id>] [--json]`

The CLI reads the registry **directly** from `@oxagen/ai/posture` rather than
calling the API — the registry is a static, client-safe module (no `@ai-sdk/*`
imports), so the command works offline and needs no auth for platform
metadata, matching how `oxagen models list` already reads its local registry.

## Access control

- Default effect: **deny** — explicit role grant required.
- Default roles: org `Owner`/`Admin`; workspace `Owner`/`Member`.
- Unscoped (`scoped: false`): this describes the platform's provider surface,
  not any tenant's rows, so there is no org/workspace data-isolation check —
  only the role grant above.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (non-string `vendor`/`model`). |

An unknown `vendor` or `model` is **not** an error — it is a normal `200`
response with `vendors: []` and `unknownFilter` set to the value that missed,
so BYOK callers can branch on "unknown" without parsing an HTTP status.

## Examples

### CLI — full matrix

```bash
$ oxagen models capabilities
Provider capability posture matrix (cache, reasoning, structured output, attachments):

  Vendor      Cache       Reasoning     Structured  Attachments
  anthropic   opt-in      controllable  native      supported
  bfl         n/a         n/a           n/a         n/a
  deepseek    implicit    unsupported   emulated    text-only
  google      implicit    controllable  native      supported
  meta        implicit    fixed-off     emulated    supported
  mistral     implicit    fixed-off     emulated    text-only
  openai      implicit    controllable  native      supported
  xai         implicit    controllable  native      supported

Run `oxagen models capabilities --vendor <vendor>` (or --model <gateway-id>) for the mechanism/witness detail behind each cell.
```

### CLI — one vendor's detail

```bash
$ oxagen models capabilities --vendor anthropic
Anthropic (anthropic)
  Models: anthropic/claude-fable-5, anthropic/claude-sonnet-5, anthropic/claude-opus-4.8, anthropic/claude-haiku-4.5

Cache: opt-in
  Anthropic caches NOTHING without an explicit breakpoint. streamAgentReply carries the
  (stable, per-workspace) system prompt as a leading system message tagged
  providerOptions.anthropic.cacheControl = {type: 'ephemeral'} — the system *param* cannot
  hold the marker, only message-level providerOptions can. Every other vendor ignores the
  anthropic namespace, so the marker is a no-op (never an error) off Anthropic.
  Witness: "prepends the system prompt as an Anthropic-cacheable system message"

Reasoning: controllable
  Claude 4.x adaptive thinking: providerOptions.anthropic.thinking = {type: 'adaptive'} plus
  outputConfig.effort carrying all five tiers verbatim (low…max — Anthropic is the only
  vendor with xhigh/max). Temperature MUST be omitted entirely while thinking is active.
  Witness: "sets adaptive thinking + output_config.effort and locks temperature"

Structured output: native
  generateObjectFor passes the zod schema to the AI SDK's generateObject; the gateway maps
  it onto Anthropic's tool-based structured output
  Witness: "calls generateObject with default temperature 0 and the schema"

Attachments: supported
  Claude accepts image parts (the `vision` capability on every Claude row in the catalog);
  no native video or audio parts — those must be transcoded to frames/transcript upstream (accepts: image)
  Witness: "distinguishes vision (image input) from image generation"
```

### CLI — unknown vendor (never a silent empty table)

```bash
$ oxagen models capabilities --vendor some-byok-provider
No posture declared for "some-byok-provider" — unknown provider.
$ echo $?
1
```

### API

```bash
curl -s "https://api.oxagen.sh/v1/model/capabilities?vendor=anthropic" | jq '.vendors[0].cache'
```
```json
{
  "kind": "opt-in",
  "mechanism": "Anthropic caches NOTHING without an explicit breakpoint. …",
  "witness": "prepends the system prompt as an Anthropic-cacheable system message"
}
```

### MCP

```json
{ "tool": "list_model_capabilities", "arguments": { "model": "openai/gpt-5.2" } }
```
returns `vendors[0].cache.kind === "implicit"` with the normalized
`inputTokenDetails.cacheReadTokens` telemetry field named in `.telemetry`.

## Related

- `@oxagen/ai/posture` (`packages/ai/src/provider-posture.ts`) — the registry itself, and its badge projection (`postureBadges`) used by the model picker UI.
- `packages/ai/src/provider-posture.test.ts` — the forward/reverse enforcement suite described above.
