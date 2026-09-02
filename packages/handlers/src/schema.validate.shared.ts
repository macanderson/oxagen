import type { SchemaFieldError } from "@oxagen/ingestion/validate";
import type { FieldError } from "@oxagen/oxagen/contracts/schema.shared";

/**
 * Map the shared validator's field-error codes onto the contract's `FieldError`
 * code enum.
 *
 * The ingestion validator (`@oxagen/ingestion/validate`) distinguishes string
 * length rules as `minLength` / `maxLength`, but the `schema.validate.*`
 * contract's `FieldError.code` enum has no length variants — it collapses them
 * onto `min` / `max` (see the §5.1 note in ingestion/validate/schema.ts). Every
 * other code is shared verbatim, so this is the single place that performs the
 * one mapping both validate handlers need.
 */
export function toContractFieldErrors(
  errors: SchemaFieldError[],
): FieldError[] {
  return errors.map((e) => ({
    field: e.field,
    message: e.message,
    code:
      e.code === "minLength" ? "min" : e.code === "maxLength" ? "max" : e.code,
  }));
}
