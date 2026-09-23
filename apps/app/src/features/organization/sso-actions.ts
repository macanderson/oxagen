"use server";
// The writes on Organization › Single sign-on and the IdP group mappings on
// Roles (ADR-145): register a provider, change it, delete it, prove its
// domain, require SSO, and replace a provider's group-to-role table. All are
// organisation-scoped, `noBillingGate`, and Owner-or-Admin in their handler:
// anyone else is answered `denied` with nothing changed.
//
// Each takes the organization slug and resolves it through `requireViewer`,
// which is where membership is checked. Slugs only: no action reads an org id
// off its input (INV-19).
//
// Secrets cross this boundary once, inward. No action returns one: the
// contracts answer with the redacted provider view, and these actions pass on
// less than that.
import { orgSsoCreate } from "@oxagen/oxagen/contracts/org.sso.create";
import { orgSsoDelete } from "@oxagen/oxagen/contracts/org.sso.delete";
import { orgSsoGroupRolesSet } from "@oxagen/oxagen/contracts/org.sso.group_roles.set";
import { orgSsoPolicySet } from "@oxagen/oxagen/contracts/org.sso.policy.set";
import { orgSsoUpdate } from "@oxagen/oxagen/contracts/org.sso.update";
import { orgSsoVerifyDomain } from "@oxagen/oxagen/contracts/org.sso.verify_domain";
import type { SsoGroupRole, SsoProtocol } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { DEFAULT_GROUPS_CLAIM } from "./sso-rules";

/** What the provider form submits. Empty strings are "not given". */
export type SsoProviderDraft = {
  readonly protocol: SsoProtocol;
  readonly providerId: string;
  readonly displayName: string;
  readonly domain: string;
  readonly groupsClaim: string;
  /** OIDC: the issuer URL. SAML: the IdP entity ID. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly entryPoint: string;
  readonly cert: string;
  readonly spPrivateKey: string;
};

/**
 * An edit also carries the protocol settings as stored, so an edit that
 * leaves them alone sends none: the handler then neither re-reads the OIDC
 * discovery document nor rewrites settings the form does not show. The
 * contract takes the certificate with every SAML change and the view never
 * returns it, so a changed entity ID or SSO URL with no certificate is
 * refused on the certificate field rather than dropped.
 */
type SsoProviderEdit = SsoProviderDraft & {
  readonly stored: {
    readonly issuer: string;
    readonly clientId: string;
    readonly entryPoint: string;
  };
};

/** A refusal the form names on a field, before any capability runs. */
function invalid(code: string, field: string): ActionResult<never> {
  return { ok: false, reason: "invalid", code, field };
}

/**
 * The kernel names a refused field by its path in the contract's input, and
 * the protocol settings sit under `config`. The form names its fields without
 * that prefix, so the path is shortened to the name the form uses.
 */
function onFormFields<T>(result: ActionResult<T>): ActionResult<T> {
  if (result.ok || result.reason !== "invalid" || result.field === undefined)
    return result;
  return { ...result, field: result.field.replace(/^config\./, "") };
}

const blank = (value: string) => value.trim() === "";

/**
 * The required fields of the protocol the draft names, checked first so an
 * empty field is named beside that field. The contract still checks them,
 * with the format rules this does not repeat.
 */
function precheckProtocol(
  draft: SsoProviderDraft,
  secretRequired: boolean,
): ActionResult<never> | null {
  if (blank(draft.issuer)) return invalid("issuer_required", "issuer");
  if (draft.protocol === "oidc") {
    if (blank(draft.clientId)) return invalid("client_id_required", "clientId");
    if (secretRequired && draft.clientSecret === "")
      return invalid("client_secret_required", "clientSecret");
    return null;
  }
  if (blank(draft.entryPoint))
    return invalid("entry_point_required", "entryPoint");
  if (secretRequired && blank(draft.cert))
    return invalid("cert_required", "cert");
  return null;
}

/** The protocol settings the contract takes. A secret left blank is left out. */
function configOf(draft: SsoProviderDraft) {
  if (draft.protocol === "oidc") {
    return {
      protocol: "oidc" as const,
      issuer: draft.issuer.trim(),
      clientId: draft.clientId.trim(),
      ...(draft.clientSecret === ""
        ? {}
        : { clientSecret: draft.clientSecret }),
    };
  }
  return {
    protocol: "saml" as const,
    issuer: draft.issuer.trim(),
    entryPoint: draft.entryPoint.trim(),
    cert: draft.cert.trim(),
    ...(blank(draft.spPrivateKey) ? {} : { spPrivateKey: draft.spPrivateKey }),
  };
}

function groupsClaimOf(draft: SsoProviderDraft): string {
  const claim = draft.groupsClaim.trim();
  return claim === "" ? DEFAULT_GROUPS_CLAIM : claim;
}

/** Registers a provider. It signs nobody in until its domain is verified. */
export async function createSsoProvider(
  org: string,
  draft: SsoProviderDraft,
): Promise<ActionResult<{ providerId: string }>> {
  if (blank(draft.providerId))
    return invalid("provider_id_required", "providerId");
  if (blank(draft.displayName))
    return invalid("display_name_required", "displayName");
  if (blank(draft.domain)) return invalid("domain_required", "domain");
  const refused = precheckProtocol(draft, true);
  if (refused) return refused;
  const ctx = await requireViewer(org);
  const config = configOf(draft);
  const result = await kernelWrite(ctx, orgSsoCreate, {
    providerId: draft.providerId.trim(),
    displayName: draft.displayName.trim(),
    domain: draft.domain.trim(),
    groupsClaim: groupsClaimOf(draft),
    // The create contract takes the client secret as required; the precheck
    // above has already refused a draft without one.
    config:
      config.protocol === "oidc"
        ? { ...config, clientSecret: draft.clientSecret }
        : config,
  });
  if (!result.ok) return onFormFields(result);
  return { ok: true, value: { providerId: result.value.provider.providerId } };
}

/**
 * Changes a provider's name, groups claim or protocol settings. A secret left
 * blank keeps the stored one. The domain and the protocol cannot change.
 */
export async function updateSsoProvider(
  org: string,
  edit: SsoProviderEdit,
): Promise<ActionResult<{ providerId: string }>> {
  if (blank(edit.displayName))
    return invalid("display_name_required", "displayName");
  const refused = precheckProtocol(edit, false);
  if (refused) return refused;
  const issuerChanged = edit.issuer.trim() !== edit.stored.issuer;
  let sendConfig: boolean;
  if (edit.protocol === "oidc") {
    sendConfig =
      issuerChanged ||
      edit.clientId.trim() !== edit.stored.clientId ||
      edit.clientSecret !== "";
  } else if (blank(edit.cert)) {
    // SAML settings travel with their certificate or not at all.
    const changed =
      issuerChanged ||
      edit.entryPoint.trim() !== edit.stored.entryPoint ||
      !blank(edit.spPrivateKey);
    if (changed) return invalid("cert_required_for_change", "cert");
    sendConfig = false;
  } else {
    sendConfig = true;
  }
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSsoUpdate, {
    providerId: edit.providerId,
    displayName: edit.displayName.trim(),
    groupsClaim: groupsClaimOf(edit),
    ...(sendConfig ? { config: configOf(edit) } : {}),
  });
  if (!result.ok) return onFormFields(result);
  return { ok: true, value: { providerId: result.value.provider.providerId } };
}

/** Deletes a provider and its group mappings. */
export async function deleteSsoProvider(
  org: string,
  providerId: string,
): Promise<ActionResult<{ deleted: true }>> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, orgSsoDelete, { providerId });
}

/**
 * Looks up the DNS TXT record for the provider's domain. A record not found
 * yet is a `conflict` with the reason `dns_record_not_found`.
 */
export async function verifySsoDomain(
  org: string,
  providerId: string,
): Promise<ActionResult<{ domainVerified: boolean }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSsoVerifyDomain, { providerId });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { domainVerified: result.value.provider.domainVerified },
  };
}

/**
 * Requires SSO, or stops requiring it. Turning it on with no verified
 * provider is a `conflict` with the reason `no_verified_provider`.
 */
export async function setSsoRequired(
  org: string,
  ssoRequired: boolean,
): Promise<ActionResult<{ ssoRequired: boolean }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSsoPolicySet, { ssoRequired });
  if (!result.ok) return result;
  return { ok: true, value: { ssoRequired: result.value.policy.ssoRequired } };
}

/**
 * Replaces a provider's whole group-to-role table: the rows sent are the rows
 * kept. A row with no group name, or a group named twice, is refused on that
 * row before any capability runs.
 */
export async function setSsoGroupRoles(
  org: string,
  providerId: string,
  rows: readonly SsoGroupRole[],
): Promise<ActionResult<{ mappings: SsoGroupRole[] }>> {
  const mappings = rows.map((row) => ({
    group: row.group.trim(),
    role: row.role,
  }));
  const seen = new Set<string>();
  for (const [index, row] of mappings.entries()) {
    if (row.group === "")
      return invalid("group_required", `mappings.${String(index)}.group`);
    if (seen.has(row.group))
      return invalid("group_duplicate", `mappings.${String(index)}.group`);
    seen.add(row.group);
  }
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSsoGroupRolesSet, {
    providerId,
    mappings,
  });
  if (!result.ok) return result;
  return { ok: true, value: { mappings: result.value.mappings } };
}
