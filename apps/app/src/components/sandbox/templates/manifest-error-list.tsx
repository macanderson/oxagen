"use client";

/**
 * Readable manifest-validation error rendering — shared by the editor's live
 * "Manifest" preview and the import dialog, so an invalid manifest always
 * reads as a path + message list, never a raw zod error dump.
 */
import type { ManifestFieldError } from "./manifest-form-state";

export function ManifestErrorList({
  errors,
}: {
  errors: ManifestFieldError[];
}) {
  if (errors.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
      data-testid="manifest-error-list"
    >
      {errors.map((e, i) => (
        <li key={i}>
          <span className="font-mono">{e.path}</span>: {e.message}
        </li>
      ))}
    </ul>
  );
}
