import { z } from "zod";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { getCapability } from "@oxagen/oxagen";
import {
  capabilityRegistryGet,
  type CapabilityFieldSpec,
} from "@oxagen/oxagen/contracts/capability.registry.get";
import { projectCapabilitySummary } from "./capability.registry.list";
import { logger } from "./logger";

/**
 * capability.registry.get handler.
 *
 * Resolves one contract from the live registry and extends the catalog summary
 * with input/output field specs derived from the contract's zod schemas at
 * read time — the catalog can never drift from the enforced shape. Unknown
 * names return `capability: null` (a clean not-found, not an error).
 */

/** Human-readable type label for a zod schema node. */
function zodTypeLabel(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: string };
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum": {
      const values = (schema as z.ZodEnum<[string, ...string[]]>).options;
      return `enum(${values.join(" | ")})`;
    }
    case "ZodNativeEnum":
      return "enum";
    case "ZodLiteral":
      return `literal(${JSON.stringify((schema as z.ZodLiteral<unknown>).value)})`;
    case "ZodArray":
      return `array<${zodTypeLabel((schema as z.ZodArray<z.ZodTypeAny>).element)}>`;
    case "ZodObject":
      return "object";
    case "ZodRecord":
      return "record";
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return "union";
    case "ZodNullable":
      return `${zodTypeLabel((schema as z.ZodNullable<z.ZodTypeAny>).unwrap())} | null`;
    case "ZodOptional":
      return zodTypeLabel((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodDefault":
      return zodTypeLabel(
        (schema._def as unknown as { innerType: z.ZodTypeAny }).innerType,
      );
    case "ZodEffects":
      return zodTypeLabel((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
    default:
      return "unknown";
  }
}

/** True when the field can be omitted from the payload. */
function isOptionalField(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName?: string };
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault")
    return true;
  if (def.typeName === "ZodNullable") {
    return isOptionalField((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
  }
  if (def.typeName === "ZodEffects") {
    return isOptionalField((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
  }
  return schema.isOptional();
}

/**
 * Derive top-level field specs from a contract IO schema. `.refine()`-wrapped
 * objects (ZodEffects) are unwrapped; non-object schemas yield [] — every
 * field list the UI renders is best-effort, never a throw.
 */
export function describeSchemaFields(
  schema: z.ZodTypeAny,
): CapabilityFieldSpec[] {
  let node: z.ZodTypeAny = schema;
  // Unwrap effect/optional/default wrappers around the object root.
  for (let i = 0; i < 5; i += 1) {
    const def = node._def as { typeName?: string };
    if (def.typeName === "ZodEffects") {
      node = (node as z.ZodEffects<z.ZodTypeAny>).innerType();
    } else if (
      def.typeName === "ZodOptional" ||
      def.typeName === "ZodNullable"
    ) {
      node = (node as z.ZodOptional<z.ZodTypeAny>).unwrap();
    } else if (def.typeName === "ZodDefault") {
      node = (node._def as unknown as { innerType: z.ZodTypeAny }).innerType;
    } else {
      break;
    }
  }
  const def = node._def as { typeName?: string };
  if (def.typeName !== "ZodObject") return [];
  const shape = (node as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape).map(([name, field]) => ({
    name,
    type: zodTypeLabel(field),
    required: !isOptionalField(field),
    description: field.description ?? null,
  }));
}

export const capabilityRegistryGetHandler: CapabilityHandler<
  typeof capabilityRegistryGet
> = async (input, ctx) => {
  const cap = getCapability(input.name);
  if (!cap) {
    logger.info(
      { orgId: ctx.orgId, name: input.name },
      "capability.registry.get: unknown capability",
    );
    return { capability: null };
  }

  return {
    capability: {
      ...projectCapabilitySummary(cap),
      inputFields: describeSchemaFields(cap.input),
      outputFields: describeSchemaFields(cap.output),
      auditTargetIdField: cap.audit?.targetIdField ?? null,
      produces: [...(cap.produces ?? [])],
      consumes: [...(cap.consumes ?? [])],
      chainHints: [...(cap.chainHints ?? [])],
    },
  };
};
