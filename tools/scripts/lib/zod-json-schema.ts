/**
 * zod-json-schema.ts: convert a Zod v3 schema into a JSON Schema fragment.
 *
 * Zod v3 schemas have no built-in JSON Schema emitter, and zod/v4's
 * toJSONSchema rejects v3 schemas, so this walks the Zod v3 `_def` tree for the
 * subset of types the contracts use. `gen-capability-schemas.ts` uses it to
 * publish `docs/capabilities/schemas/`. It lives here, apart from that script,
 * so a test can import it without running the generator.
 */
export type JsonSchema = Record<string, unknown>;

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
  checks?: Array<{ kind: string; value?: number; inclusive?: boolean }>;
  defaultValue?: () => unknown;
  items?: Array<{ _def: ZodDefLike }>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
}

export interface ZodLike {
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
    case "ZodCatch": {
      // `.catch()` answers a fallback for any input the inner schema refuses,
      // absence included, so the field never fails a parse and is never
      // required. The inner schema is still what a well-formed value is.
      const inner = convert(d.innerType as ZodLike);
      return { schema: withDesc(inner.schema), optional: true };
    }
    case "ZodNullable": {
      const inner = convert(d.innerType as ZodLike);
      return {
        schema: { anyOf: [inner.schema, { type: "null" }] },
        optional: inner.optional,
      };
    }
    case "ZodEffects": {
      // A `.refine()` / `.superRefine()` predicate is arbitrary TypeScript, so
      // there is no JSON Schema for it and none can be generated. What matters
      // is that the published artifact does not pretend otherwise: unwrapping
      // silently emitted a schema strictly more permissive than the kernel, so
      // an external client could validate `{ "scope": "org" }` against the
      // published `export_data` schema and still be refused at `invoke()`, with
      // the machine-readable contract saying the payload was fine.
      //
      // So the constraint is not expressed, and the omission is declared. A
      // consumer reading `x-server-validated` knows this schema is necessary
      // but not sufficient, and that a local pass does not predict the answer.
      // The alternative, refusing to generate for the 37 contracts that use a
      // refinement until each is rewritten into a discriminated union the
      // generator can express, is the durable end state and a change to those
      // contracts rather than to this script.
      const inner = convert(d.schema as ZodLike);
      return {
        schema: {
          ...inner.schema,
          "x-server-validated": true,
          "x-server-validated-note":
            "The server applies at least one further constraint that this schema does not express. Validating against this schema is necessary but not sufficient; the capability may still refuse the payload.",
        },
        optional: inner.optional,
      };
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
        schema: withDesc({
          type: "array",
          items: item.schema,
          ...((d.exactLength ?? d.minLength)
            ? { minItems: (d.exactLength ?? d.minLength)!.value }
            : {}),
          ...((d.exactLength ?? d.maxLength)
            ? { maxItems: (d.exactLength ?? d.maxLength)!.value }
            : {}),
        }),
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
      // Zod v3 stores `.positive()` and `.gt(n)` as a `min` check with
      // `inclusive: false`, and `.negative()` and `.lt(n)` as a `max` check
      // with `inclusive: false`. JSON Schema names an exclusive bound with its
      // own keyword. Publishing one as `minimum` or `maximum` told a consumer
      // that the boundary value itself was valid, and `invoke()` refused it.
      // Several bounds of one kind all apply, so the tightest one is kept.
      for (const ck of d.checks ?? []) {
        if (typeof ck.value !== "number") continue;
        if (ck.kind === "min") {
          const key = ck.inclusive === false ? "exclusiveMinimum" : "minimum";
          const current = s[key];
          s[key] =
            typeof current === "number"
              ? Math.max(current, ck.value)
              : ck.value;
        }
        if (ck.kind === "max") {
          const key = ck.inclusive === false ? "exclusiveMaximum" : "maximum";
          const current = s[key];
          s[key] =
            typeof current === "number"
              ? Math.min(current, ck.value)
              : ck.value;
        }
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

export function toJsonSchema(schema: ZodLike): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...convert(schema).schema,
  };
}
