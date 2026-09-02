import { z } from "zod";

/**
 * Canonical avatar-value validation, shared by every contract that carries an
 * agent or workspace avatar (agent.definition.create/update,
 * workspace.settings.read/write).
 *
 * An avatar value is a nullable text field that is EITHER:
 *  - an `https://` URL to a hosted image, OR
 *  - the platform designed-avatar spec string `avatar:v1:<json>`, where the
 *    JSON is `{"emoji":"🦊","bg":"#f59e0b","mode":"full"}` and `mode` is one of
 *    `full | mono-light | mono-dark`.
 *
 * Capped at 512 chars — long enough for the spec string, short enough to keep it
 * out of "store a blob in a text column" territory. Validation here is a cheap
 * shape gate (prefix + length); the full spec JSON is parsed by the UI/renderer,
 * not re-validated on every write.
 */
export const AVATAR_MAX_LEN = 512;

/** Designed-avatar spec-string prefix (versioned so the format can evolve). */
export const AVATAR_SPEC_PREFIX = "avatar:v1:";

export const avatarUrlSchema = z
  .string()
  .max(
    AVATAR_MAX_LEN,
    `avatar value must be at most ${AVATAR_MAX_LEN} characters`,
  )
  .refine(
    (value) =>
      value.startsWith("https://") || value.startsWith(AVATAR_SPEC_PREFIX),
    {
      message:
        'avatar value must be an https:// URL or a designed-avatar string ("avatar:v1:<json>")',
    },
  );

/** Output shape: whatever is persisted, or null when unset. No refinement — the
 *  column is the source of truth, not the writer. */
export const avatarUrlOutputSchema = z.string().nullable();
