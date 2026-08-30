/**
 * gen-capability-schemas.ts — generate per-capability input/output JSON Schema
 * documentation for every registered contract.
 *
 * Zod v3 schemas don't have a built-in JSON Schema emitter (and zod/v4's
 * toJSONSchema rejects v3 schemas), so this walks the Zod v3 `_def` tree for the
 * subset of types the contracts use. No new dependency — deterministic, runnable
 * in the gate.
 *
 *   pnpm tsx tools/scripts/gen-capability-schemas.ts
 *
 * Outputs:
 *   docs/capabilities/schemas/<capability>.json   (one per capability)
 *   docs/capabilities/schemas/_index.json         (machine-readable catalog)
 *   docs/capabilities/schemas/README.md           (human summary)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Importing the package root runs its `import "./contracts.generated"` side
// effect, registering every contract before we enumerate them.
import {
  listCapabilities,
  getCapabilityChain,
  getRenderHint,
} from "@oxagen/oxagen";

type JsonSchema = Record<string, unknown>;

interface ZodDefLike {
  typeName?: string;
  description?: string;
  innerType?: { _def: ZodDefLike };
  schema?: { _def: ZodDefLike };
  type?: { _def: ZodDefLike };
  valueType?: { _def: ZodDefLike };
  shape?: () => Record<string, { _def: ZodDefLike }>;
  values?: unknown;
  value?: unknown;
  options?: Array<{ _def: ZodDefLike }>;
  checks?: Array<{ kind: string; value?: number }>;
  defaultValue?: () => unknown;
  items?: Array<{ _def: ZodDefLike }>;
}

interface ZodLike {
  _def: ZodDefLike;
}

function def(schema: ZodLike): ZodDefLike {
  return schema._def;
}

/** Convert a Zod v3 schema into a JSON Schema fragment. Returns { schema, optional }. */
function convert(schema: ZodLike): { schema: JsonSchema; optional: boolean } {
  const d = def(schema);
  const description = d.description;
  const withDesc = (s: JsonSchema): JsonSchema =>
    description ? { ...s, description } : s;

  switch (d.typeName) {
    case "ZodOptional": {
      const inner = convert(d.innerType as ZodLike);
      return { schema: inner.schema, optional: true };
    }
    case "ZodDefault": {
      const inner = convert(d.innerType as ZodLike);
      let dft: unknown;
      try {
        dft = d.defaultValue?.();
      } catch {
        dft = undefined;
      }
      return { schema: { ...inner.schema, default: dft }, optional: true };
    }
    case "ZodNullable": {
      const inner = convert(d.innerType as ZodLike);
      return {
        schema: { anyOf: [inner.schema, { type: "null" }] },
        optional: inner.optional,
      };
    }
    case "ZodEffects": {
      return convert(d.schema as ZodLike);
    }
    case "ZodObject": {
      const shape = d.shape?.() ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        const c = convert(child as ZodLike);
        properties[key] = c.schema;
        if (!c.optional) required.push(key);
      }
      return {
        schema: withDesc({
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        }),
        optional: false,
      };
    }
    case "ZodArray": {
      const item = convert(d.type as ZodLike);
      return {
        schema: withDesc({ type: "array", items: item.schema }),
        optional: false,
      };
    }
    case "ZodRecord": {
      const value = d.valueType ? convert(d.valueType as ZodLike).schema : {};
      return {
        schema: withDesc({ type: "object", additionalProperties: value }),
        optional: false,
      };
    }
    case "ZodString": {
      const s: JsonSchema = { type: "string" };
      for (const ck of d.checks ?? []) {
        if (ck.kind === "min" && typeof ck.value === "number")
          s.minLength = ck.value;
        if (ck.kind === "max" && typeof ck.value === "number")
          s.maxLength = ck.value;
        if (ck.kind === "url") s.format = "uri";
        if (ck.kind === "uuid") s.format = "uuid";
        if (ck.kind === "email") s.format = "email";
      }
      return { schema: withDesc(s), optional: false };
    }
    case "ZodNumber": {
      const isInt = (d.checks ?? []).some((c) => c.kind === "int");
      const s: JsonSchema = { type: isInt ? "integer" : "number" };
      for (const ck of d.checks ?? []) {
        if (ck.kind === "min" && typeof ck.value === "number")
          s.minimum = ck.value;
        if (ck.kind === "max" && typeof ck.value === "number")
          s.maximum = ck.value;
      }
      return { schema: withDesc(s), optional: false };
    }
    case "ZodBoolean":
      return { schema: withDesc({ type: "boolean" }), optional: false };
    case "ZodEnum":
      return {
        schema: withDesc({ type: "string", enum: d.values as unknown[] }),
        optional: false,
      };
    case "ZodNativeEnum":
      return {
        schema: withDesc({
          enum: Object.values(d.values as Record<string, unknown>),
        }),
        optional: false,
      };
    case "ZodLiteral":
      return { schema: withDesc({ const: d.value }), optional: false };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const opts = (d.options ?? []).map((o) => convert(o as ZodLike).schema);
      return { schema: withDesc({ anyOf: opts }), optional: false };
    }
    case "ZodTuple": {
      const items = (d.items ?? []).map((i) => convert(i as ZodLike).schema);
      return { schema: withDesc({ type: "array", items }), optional: false };
    }
    case "ZodDate":
      return {
        schema: withDesc({ type: "string", format: "date-time" }),
        optional: false,
      };
    case "ZodUnknown":
    case "ZodAny":
      return { schema: withDesc({}), optional: false };
    default:
      // Unknown type — emit an open schema annotated with the Zod type name so
      // the gap is visible rather than silently wrong.
      return {
        schema: withDesc({ "x-zod-type": d.typeName ?? "unknown" }),
        optional: false,
      };
  }
}

function toJsonSchema(schema: ZodLike): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...convert(schema).schema,
  };
}

// ── Generate ──────────────────────────────────────────────────────────────────

const outDir = join(process.cwd(), "docs", "capabilities", "schemas");
mkdirSync(outDir, { recursive: true });

const caps = listCapabilities().sort((a, b) => a.name.localeCompare(b.name));
const index: Array<Record<string, unknown>> = [];

for (const cap of caps) {
  const chain = getCapabilityChain(cap.name);
  const renderHint = getRenderHint(cap.name);
  const doc = {
    name: cap.name,
    domain: cap.domain,
    description: cap.description,
    mode: cap.mode,
    surfaces: cap.surfaces ?? ["api", "mcp"],
    sensitivity: cap.sensitivity,
    agent: cap.agent ?? null,
    chain: {
      produces: chain.produces,
      consumes: chain.consumes,
      chainHints: chain.chainHints,
    },
    render: renderHint ?? null,
    input: toJsonSchema(cap.input as unknown as ZodLike),
    output: toJsonSchema(cap.output as unknown as ZodLike),
  };
  writeFileSync(
    join(outDir, `${cap.name}.json`),
    JSON.stringify(doc, null, 2) + "\n",
  );
  index.push({
    name: cap.name,
    domain: cap.domain,
    surfaces: doc.surfaces,
    component: renderHint?.componentId ?? null,
    produces: chain.produces,
    consumes: chain.consumes,
  });
}

writeFileSync(
  join(outDir, "_index.json"),
  JSON.stringify(
    { generatedCount: caps.length, capabilities: index },
    null,
    2,
  ) + "\n",
);

const byDomain = new Map<string, string[]>();
for (const cap of caps) {
  const list = byDomain.get(cap.domain) ?? [];
  list.push(cap.name);
  byDomain.set(cap.domain, list);
}
const readme = [
  `# Capability JSON Schemas`,
  ``,
  `Auto-generated by \`tools/scripts/gen-capability-schemas.ts\`. One \`<capability>.json\``,
  `per capability with its input + output JSON Schema, chain metadata`,
  `(produces/consumes/chainHints), and chat render component. Do not edit by hand.`,
  ``,
  `**${caps.length} capabilities** across ${byDomain.size} domains.`,
  ``,
  ...[...byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([domain, names]) =>
        `- **${domain}** (${names.length}): ${names.join(", ")}`,
    ),
  ``,
].join("\n");
writeFileSync(join(outDir, "README.md"), readme);

console.log(
  `Wrote ${caps.length} capability schema docs to docs/capabilities/schemas/`,
);
