# Capability declaration (`packages/oxagen`)

Declare the capability once. The schema, API route, and MCP tool all import from here. This is the source of truth for parity.

## Registry entry

```ts
// packages/oxagen/src/capabilities/<capability-name>.ts
import { z } from "zod";
import { defineCapability } from "../registry";

export const <camelName>Input = z.object({
  // tenant/workspace scope is injected by the caller context, not declared here
  // design batch-capable inputs by default: accept an array where it makes sense
  items: z.array(z.object({
    // ...fields
  })).min(1),
});

export const <camelName>Output = z.object({
  results: z.array(z.object({
    // per-item result so batch and sync share one shape
  })),
});

export const <camelName>Capability = defineCapability({
  name: "<capability.name>",            // dotted, stable, used in the manifest
  mode: "batch",                          // "sync" | "async" | "batch" — decided FIRST
  input: <camelName>Input,
  output: <camelName>Output,
  description: "Active-voice, present-tense, one line describing intent.",
  // layers this capability is expected to satisfy; the gate checks these exist
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "marketing"],
});
```

## Rules

- Pick `mode` before writing the schema. It dictates whether the output is an immediate result, a job handle, or per-item batch results.
- Export the Zod schemas. Every downstream layer imports these exact objects. Never redeclare a schema in the route or the MCP tool.
- The `name` is stable and dotted (e.g. `node.bulkUpsert`). It is the manifest key.
- `layers` lists what the verification gate requires. Drop `marketing` only for purely internal capabilities; the gate records the omission.
- Keep tenant and workspace scope out of the input schema. Scope comes from the authenticated caller context so a malformed input can never cross tenants.
