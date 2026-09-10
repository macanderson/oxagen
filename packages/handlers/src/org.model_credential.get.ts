// audit-exempt: read-only credential fetch that returns NO secret material — the
// kernel's capability.invoke_* audit already records who read it. Only the
// mutations (org.model_credential.set / .delete) warrant a domain-specific
// model_credential.* row.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import {
  type ModelCredentialView,
  modelCredentialProviderSchema,
} from "@oxagen/oxagen/contracts/org.model_credential.shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  type ModelCredentialRow,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { logger } from "./logger";

/**
 * Project a credential row onto the REDACTED wire shape (ADR-053 §2): the
 * provider, the status, the last four characters, and two timestamps. Never
 * the ciphertext, never the digest, never the key. Anything not listed here
 * does not leave the process.
 *
 * `null` is an organisation with no stored key — the same answer the
 * funding-source resolver gives, so the settings page and the runtime never
 * disagree about who pays.
 */
export function toCredentialView(
  row: Pick<
    ModelCredentialRow,
    "provider" | "status" | "keyHint" | "lastVerifiedAt" | "rotatedAt"
  > | null,
): ModelCredentialView {
  if (!row) {
    return {
      configured: false,
      provider: null,
      status: null,
      keyHint: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    };
  }
  // The column's CHECK admits exactly the shared schema's values, so a parse
  // failure here is schema drift, and a view that named the wrong vendor would
  // be worse than the thrown error.
  const provider = modelCredentialProviderSchema.parse(row.provider);
  // An unknown status narrows to disabled: that is the direction the resolver
  // already takes (anything but `active` resolves to the platform key), so the
  // page shows the state the runtime is in.
  const status = row.status === "active" ? "active" : "disabled";
  return {
    configured: true,
    provider,
    status,
    keyHint: row.keyHint,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
  };
}

/**
 * get_model_credential — has this organisation stored its own model-vendor
 * key, and which one?
 *
 * withTenantDb, unlike the data-plane read beside it: nothing resolves THROUGH
 * `org.model_credentials`, so RLS is the filter and the caller is already
 * inside the organisation's scope (see the resolver header in
 * `@oxagen/database/model-credential`). The explicit `ctx.orgId` equality is
 * kept so the query says what it means even where RLS is off.
 *
 * The read never opens the envelope: everything the view needs is a plain
 * column. There is no read-back path for the key by design.
 */
export const orgModelCredentialGetHandler: CapabilityHandler<
  typeof orgModelCredentialGet
> = async (_input, ctx) => {
  const row = await withTenantDb((tx) =>
    tx.query.modelCredentials.findFirst({
      where: and(
        eq(schema.modelCredentials.orgId, ctx.orgId),
        isNull(schema.modelCredentials.deletedAt),
      ),
    }),
  );

  const view = toCredentialView(row ?? null);
  logger.info(
    // Never the key, the digest or the hint: configured/provider/status only.
    {
      orgId: ctx.orgId,
      configured: view.configured,
      provider: view.provider,
      status: view.status,
      surface: ctx.surface,
    },
    "org.model_credential.get: returned the organisation's credential view",
  );
  return view;
};
