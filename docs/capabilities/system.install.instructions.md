# system.install.instructions

**Domain:** system
**Mode:** sync
**Scope:** tenant + workspace

## Intent

Return ordered, copy-ready MCP installation instructions for a given AI
client (claude-code, cursor, claude-desktop, codex, vscode). Uses the
production Vercel app domains from `CLAUDE.md` throughout — no hard-coded
localhost values.

This is the end-to-end proof of the chat component registry pipeline:
the output includes a `render` directive pointing at `install-instructions`,
so the result renders inline in chat without any additional wiring.

## Input

| Field           | Type                                                                           | Notes                                                        |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `client`        | `"claude-code" \| "cursor" \| "claude-desktop" \| "codex" \| "vscode"`        | The AI client to generate installation instructions for.     |
| `workspaceSlug` | `string` (optional)                                                            | Slug used to build personalised MCP URL / config snippets.  |

## Output

| Field    | Type                 | Notes                                                                                |
| -------- | -------------------- | ------------------------------------------------------------------------------------ |
| `client` | `InstallClient`      | Echoes the requested client.                                                         |
| `steps`  | `InstallStep[]` (min 1) | Ordered installation steps. Each step has a `label` and an optional `command`.   |
| `render` | `RenderDirective`    | `{ componentId: "install-instructions", props: { client, steps } }`                 |

### InstallStep

| Field     | Type                | Notes                                                              |
| --------- | ------------------- | ------------------------------------------------------------------ |
| `label`   | `string` (min 1)    | Human-readable description of the step.                            |
| `command` | `string` (optional) | Shell command or config snippet; shown with a copy-to-clipboard button. |

## Production URLs used

All commands reference the interim Vercel deployment domains:

- API: `https://api.oxagen.sh`
- App (API key dashboard): `https://app.oxagen.sh`

These will be replaced by the `oxagen.ai` domain via an env-var sweep when
the brand domain is ready — they are centralised in the handler, not scattered
across individual steps.

## Side effects

None — pure computation, no model call, no DB write, no telemetry.

## Errors

| code              | meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `400 Bad Request` | Input failed Zod validation (unknown client, missing client field).      |
| `401 Unauthorized`| No valid session or API key.                                             |
| `403 Forbidden`   | Caller lacks `system.install.instructions` permission for org/workspace. |

## SPEC references

- Chat component registry — `apps/app/src/components/chat/chat-component-registry.tsx`
- Install instructions component — `apps/app/src/components/chat/registry-components/install-instructions.tsx`
- Production URLs — `CLAUDE.md §Production URLs`
