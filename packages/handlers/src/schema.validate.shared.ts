import type { SchemaFieldError } from "@oxagen/ingestion/validate";
import type { FieldError } from "@oxagen/oxagen/contracts/schema.shared";

/**
 * Map the shared validator's field-error codes onto the contract's `FieldError`
 * code enum.
 *
 * The ingestion validator (`@oxagen/ingestion/validate`) draws distinctions the
 * `schema.validate.*` contract's `FieldError.code` enum does not carry, and this
 * is the single place that collapses them for both validate handlers.
 *
 * - `minLength` / `maxLength` → `min` / `max`. The contract has no length
 *   variants (see the §5.1 note in ingestion/validate/schema.ts).
 * - `patternInvalid` → `pattern`. The validator separates "this value does not
 *   match the pattern" from "the schema's pattern does not compile", because
 *   the second is a registry defect rather than a data one (#1425). The
 *   contract cannot say that, and the value is not conformant either way, so it
 *   arrives as `pattern`. The distinction is not lost — it stays in the
 *   `message`, which names the offending pattern and says to fix it in the
 *   registry.
 */
export function toContractFieldErrors(
  errors: SchemaFieldError[],
): FieldError[] {
  return errors.map((e) => ({
    field: e.field,
    message: e.message,
    code:
      e.code === "minLength"
        ? "min"
        : e.code === "maxLength"
          ? "max"
          : e.code === "patternInvalid"
            ? "pattern"
            : e.code,
  }));
}
