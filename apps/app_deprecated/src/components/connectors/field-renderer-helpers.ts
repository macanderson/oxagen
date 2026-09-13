/**
 * field-renderer-helpers.ts — Pure validation helper for connector field values.
 * No React, no side-effects. Safe to import in any context.
 */

import type { SchemaField } from "./field-renderer-types";

/**
 * Validates a single field value against its schema constraints.
 * Returns an error message string on failure, or null if valid.
 */
export function validateField(
  field: SchemaField,
  value: unknown,
): string | null {
  const v = field.validation;
  // No constraints declared → nothing to check.
  if (!v) return null;

  // Required
  if (v.required) {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return "Required";
    }
  }

  // String validations
  if (typeof value === "string") {
    if (v.pattern) {
      const re = new RegExp(v.pattern);
      if (!re.test(value)) return `Invalid format`;
    }
  }

  // Number validations
  if (typeof value === "number") {
    if (v.min !== undefined && value < v.min)
      return `Minimum value is ${v.min}`;
    if (v.max !== undefined && value > v.max)
      return `Maximum value is ${v.max}`;
  }

  // Array validations
  if (Array.isArray(value)) {
    if (v.minItems !== undefined && value.length < v.minItems) {
      return `At least ${v.minItems} item${v.minItems !== 1 ? "s" : ""} required`;
    }
    if (v.maxItems !== undefined && value.length > v.maxItems) {
      return `At most ${v.maxItems} item${v.maxItems !== 1 ? "s" : ""} allowed`;
    }
    if (v.itemPattern) {
      const re = new RegExp(v.itemPattern);
      const invalid = (value as string[]).find((item) => !re.test(item));
      if (invalid) return `"${invalid}" is not a valid format`;
    }
  }

  return null;
}
