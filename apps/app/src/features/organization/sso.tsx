// Organization › Single sign-on (ADR-144): the organisation's OIDC and SAML
// identity providers, the DNS record that proves each one's email domain, the
// URLs the admin pastes into the identity provider, and whether members must
// sign in through one.
//
// Org-scoped, Owner or Admin in every handler. A viewer below that role is
// answered `denied` by the read, and this section says so rather than
// showing controls every write of which would be refused. A member who can
// read (the handlers decide) sees the page without its controls.
//
// SSO is part of the Enterprise plan. On any other plan the page says so,
// links to Billing, and offers only what an organisation that left the plan
// needs to clean up: deleting a provider and turning Require SSO off.
import { useTranslations } from "next-intl";
import type { SsoProvider, SsoSettings } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { linkText, mono, panel } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import {
  CopyValue,
  DeleteProvider,
  RequireSso,
  VerifyDomain,
} from "./sso-controls";
import { SsoProviderDialog } from "./sso-provider-form";
import { OrganizationTabs } from "./tabs";

const sectionTitle = "text-base font-semibold text-foreground";
const lead = "text-sm text-muted-foreground";

export async function Sso({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.org.sso(ctx);
  return (
    <SsoSection
      org={ctx.orgSlug}
      canEdit={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      read={read}
    />
  );
}

function SsoSection({
  org,
  canEdit,
  read,
}: {
  org: string;
  /** Owners and admins edit; the handlers check the role again. */
  canEdit: boolean;
  read: Read<SsoSettings>;
}) {
  const t = useTranslations("organization.sso");
  return (
    <div className="flex flex-col gap-6">
      <OrganizationTabs org={org} current="sso" />
      <p className="max-w-3xl text-sm text-muted-foreground">{t("intro")}</p>
      {read.ok ? (
        <>
          {read.value.entitled ? null : (
            <SsoPlanNotice
              org={org}
              hasProviders={read.value.providers.length > 0}
            />
          )}
          <Providers org={org} canEdit={canEdit} value={read.value} />
          {read.value.providers.map((provider) => (
            <Setup
              key={provider.providerRef}
              org={org}
              canSetUp={canEdit && read.value.entitled}
              provider={provider}
            />
          ))}
          {read.value.entitled || read.value.policy.ssoRequired ? (
            <Policy org={org} canEdit={canEdit} value={read.value} />
          ) : null}
        </>
      ) : read.reason === "denied" ? (
        <OutcomePanel tone="deny" testId="sso-denied" title={t("denied.title")}>
          {t("denied.body")}
        </OutcomePanel>
      ) : (
        <ReadFailure read={read} section={t("title")} />
      )}
    </div>
  );
}

/**
 * What a plan without SSO means on this page, with the way to change the
 * plan. The Roles page shows it above the group mappings too.
 */
export function SsoPlanNotice({
  org,
  hasProviders,
}: {
  org: string;
  /** Existing providers stop signing people in once the plan lapses. */
  hasProviders: boolean;
}) {
  const t = useTranslations("organization.sso.plan");
  return (
    <p className={lead} data-testid="sso-plan-notice">
      {t("notice")} {hasProviders ? `${t("lapsed")} ` : null}
      <SafeLink to={routes.billing(org)} className={linkText}>
        {t("upgrade")}
      </SafeLink>
    </p>
  );
}

function DomainStatus({ verified }: { verified: boolean }) {
  const t = useTranslations("organization.sso.providers");
  return verified ? (
    <Badge tone="allowed" data-domain-status="verified">
      {t("verified")}
    </Badge>
  ) : (
    <Badge tone="approval" data-domain-status="pending">
      {t("pending")}
    </Badge>
  );
}

function Providers({
  org,
  canEdit,
  value,
}: {
  org: string;
  canEdit: boolean;
  value: SsoSettings;
}) {
  const t = useTranslations("organization.sso");
  // Adding or editing a provider sets SSO up, so it needs the plan. Deleting
  // one does not, so an organisation that left the plan can clean up.
  const canSetUp = canEdit && value.entitled;
  const columns = [
    { label: t("providers.columns.name") },
    { label: t("providers.columns.protocol") },
    { label: t("providers.columns.domain") },
    { label: t("providers.columns.status") },
    ...(canEdit ? [{ label: t("providers.columns.actions") }] : []),
  ];
  return (
    <section aria-labelledby="sso-providers" className="flex flex-col gap-3">
      <h2 id="sso-providers" className={sectionTitle}>
        {t("providers.title")}
      </h2>
      {canSetUp ? (
        <div className="flex flex-wrap gap-2">
          <SsoProviderDialog org={org} />
        </div>
      ) : canEdit ? null : (
        <p className={lead}>{t("readOnly")}</p>
      )}
      {value.providers.length === 0 ? (
        <p className={lead} data-testid="sso-empty">
          {t("providers.empty")}
        </p>
      ) : (
        <Table label={t("providers.tableLabel")} columns={columns}>
          {value.providers.map((provider) => (
            <tr key={provider.providerRef} data-provider={provider.providerRef}>
              <td className={cell}>
                <div className="font-medium text-foreground">
                  {provider.displayName}
                </div>
                <div className={`${mono} text-muted-foreground`}>
                  {provider.providerRef}
                </div>
              </td>
              <td className={cell}>{t(`protocols.${provider.protocol}`)}</td>
              <td className={`${cell} ${mono}`}>{provider.domain}</td>
              <td className={cell}>
                <DomainStatus verified={provider.domainVerified} />
              </td>
              {canEdit ? (
                <td className={cell}>
                  <div className="flex flex-wrap gap-2">
                    {canSetUp ? (
                      <SsoProviderDialog org={org} provider={provider} />
                    ) : null}
                    <DeleteProvider org={org} provider={provider} />
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

/** What the admin publishes in DNS and pastes into the identity provider. */
function Setup({
  org,
  canSetUp,
  provider,
}: {
  org: string;
  /** The viewer is an Owner or Admin, and the plan includes SSO. */
  canSetUp: boolean;
  provider: SsoProvider;
}) {
  const t = useTranslations("organization.sso.setup");
  const id = `sso-setup-${provider.providerRef}`;
  return (
    <section
      aria-labelledby={id}
      className={`${panel} flex flex-col gap-5 p-5`}
      data-testid={id}
    >
      <h2 id={id} className={sectionTitle}>
        {t("title", { name: provider.displayName })}
      </h2>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("dnsTitle")}
        </h3>
        {provider.domainVerified ? (
          <p className={lead}>
            {t("dnsVerified", { domain: provider.domain })}
          </p>
        ) : (
          <p className={lead}>{t("dnsLead")}</p>
        )}
        <CopyValue
          label={t("recordName")}
          value={provider.verification.recordName}
          testId={`${id}-record-name`}
        />
        <CopyValue
          label={t("recordValue")}
          value={provider.verification.recordValue}
          testId={`${id}-record-value`}
        />
        {canSetUp && !provider.domainVerified ? (
          <VerifyDomain org={org} providerId={provider.providerRef} />
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("idpTitle")}
        </h3>
        <p className={lead}>{t("idpLead")}</p>
        <CopyValue
          label={provider.protocol === "oidc" ? t("redirectUri") : t("acsUrl")}
          value={provider.callbackUrl}
          testId={`${id}-callback`}
        />
        {provider.spMetadataUrl === null ? null : (
          <CopyValue
            label={t("spMetadataUrl")}
            value={provider.spMetadataUrl}
            testId={`${id}-metadata`}
          />
        )}
      </div>
    </section>
  );
}

function Policy({
  org,
  canEdit,
  value,
}: {
  org: string;
  canEdit: boolean;
  value: SsoSettings;
}) {
  const t = useTranslations("organization.sso.policy");
  return (
    <section
      aria-labelledby="sso-policy"
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      <h2 id="sso-policy" className={sectionTitle}>
        {t("title")}
      </h2>
      <RequireSso
        org={org}
        required={value.policy.ssoRequired}
        canTurnOn={
          value.entitled && value.providers.some((p) => p.domainVerified)
        }
        canEdit={canEdit}
        lapsed={!value.entitled}
      />
    </section>
  );
}
