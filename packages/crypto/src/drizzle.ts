/**
 * Drizzle ORM column helper for encrypted-bytea columns.
 *
 * Usage in a schema file:
 *
 *   import { encryptedBytea } from "@oxagen/crypto/drizzle";
 *
 *   export const myTable = pgSchema("my").table("my_table", {
 *     secretValue: encryptedBytea("secret_value"),
 *   });
 *
 * The column stores a raw Buffer at the Drizzle layer; your service layer is
 * responsible for calling `encrypt()` before writing and `decrypt()` after
 * reading.  This helper only marks the column type so TypeScript rejects
 * accidental `text` assignments.
 *
 * Note: Drizzle has no first-class `bytea` helper; we declare it via
 * `customType` exactly as the `credentials.encryptedPayload` column does.
 */

import { customType } from "drizzle-orm/pg-core";

/**
 * A `bytea` Drizzle column typed as `Buffer` — the opaque wire type for
 * envelope-encrypted payloads.
 */
export const encryptedBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
