/**
 * The two identifier shapes every artifact file agrees on. They live here, and
 * only here, so that a change to either spelling is a one-line change instead
 * of a hunt across `schemas.ts` and `lifecycle.ts`.
 *
 * These are plain `RegExp` values rather than Zod schemas because `schemas.ts`
 * already imports `lifecycle.ts`; a shared *schema* module would have to be
 * imported by both and would invert that direction. Neither pattern carries the
 * `g` flag, so a single shared instance is safe to reuse across validators.
 */

/**
 * Kebab-case slug: lowercase alphanumerics in one or more `-`-joined segments.
 * Used for artifact names (`code-reviewer`) and lifecycle invocation ids.
 */
export const KEBAB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Verb-first snake_case capability slug per ADR-025 (`read_file`,
 * `build_prompt_patch`). The first segment must start with a letter so a
 * capability can never be spelled as a bare number.
 */
export const CAPABILITY_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
