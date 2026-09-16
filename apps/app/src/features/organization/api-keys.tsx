// Organization › API keys (ARCHITECTURE.md §1.2): every key the organization
// holds, from list_api_keys, under the tabs that link People and API keys. The
// contract returns no secret and no hash, so the table prints the prefix that
// identifies a key on sight and the instants of its life, and nothing that
// could be exchanged for access. A refused or failed read replaces the table;
// the tabs stay. Create, rotate and revoke land with the API key writes.
import { useTranslations } from "next-intl";
import type { ApiKey } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { RouteTabs } from "@/ui/route-tabs";
import { cell, Table } from "@/ui/table";
import { DateCell, emptyLine } from "./parts";

export async function ApiKeys({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.org.apiKeys(ctx);
  return (
    <ApiKeysView orgSlug={ctx.orgSlug} orgRole={ctx.orgRole} read={read} />
  );
}

function ApiKeysView({
  orgSlug,
  orgRole,
  read,
}: {
  orgSlug: string;
  orgRole: OrgRole;
  read: Read<ApiKey[]>;
}) {
  const t = useTranslations("organization");
  return (
    <div className="flex flex-col gap-6">
      <RouteTabs
        label={t("tabs.label")}
        tabs={[
          {
            to: routes.people(orgSlug),
            label: t("tabs.people"),
            current: false,
          },
          {
            to: routes.apiKeys(orgSlug),
            label: t("tabs.apiKeys"),
            current: true,
          },
        ]}
      />
      {read.ok ? (
        <Keys keys={read.value} />
      ) : read.reason === "denied" ? (
        <OutcomePanel
          tone="deny"
          testId="api-keys-denied"
          title={t("apiKeys.denied.title")}
        >
          {t("apiKeys.denied.body", {
            role: t(`roles.${orgRole}`),
            permission: read.permission,
          })}
        </OutcomePanel>
      ) : read.reason === "pending_approval" ? (
        <OutcomePanel
          tone="neutral"
          testId="api-keys-pending"
          title={t("apiKeys.pending.title")}
        >
          {t("apiKeys.pending.body", { id: read.accessRequestId })}
        </OutcomePanel>
      ) : (
        <OutcomePanel
          tone="neutral"
          testId="api-keys-error"
          title={t("apiKeys.error.title")}
        >
          {t("apiKeys.error.body", { status: read.status, code: read.code })}
        </OutcomePanel>
      )}
    </div>
  );
}

/**
 * The key's state as a dot and a word, off the two instants the record carries.
 * Revocation is a decision and outranks the clock; past that, an `expiresAt`
 * already behind us is what the platform itself reads — both `tacho-host.ts`
 * and `telemetry.stella.ingest.ts` admit a key only on
 * `expiresAt IS NULL OR expiresAt > now()` — so a key past its expiry is dead
 * and calling it "live" beside an Expires column printing a past date states
 * something stronger than the record (mockups/pages/organization-api-keys.md,
 * ARCHITECTURE.md §3.4). This component renders on the server, so the clock is
 * the server's and there is no hydration split to keep out of it.
 */
function KeyStatus({
  revokedAt,
  expiresAt,
}: {
  revokedAt: string | null;
  expiresAt: string | null;
}) {
  const t = useTranslations("organization.apiKeys.status");
  const status =
    revokedAt !== null
      ? "revoked"
      : expiresAt !== null && Date.parse(expiresAt) <= Date.now()
        ? "expired"
        : "live";
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${status === "live" ? "bg-success" : "bg-muted-foreground"}`}
      />
      {t(status)}
    </span>
  );
}

function Keys({ keys }: { keys: readonly ApiKey[] }) {
  const t = useTranslations("organization.apiKeys");
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">{t("lead")}</p>
      {keys.length === 0 ? (
        <p className={emptyLine}>{t("empty")}</p>
      ) : (
        <Table
          label={t("tableLabel")}
          columns={[
            { label: t("columns.name") },
            { label: t("columns.prefix") },
            { label: t("columns.created") },
            { label: t("columns.lastUsed") },
            { label: t("columns.expires") },
            { label: t("columns.status") },
          ]}
        >
          {keys.map((key) => (
            <tr key={key.id} data-api-key={key.id}>
              <td className={`${cell} font-medium text-foreground`}>
                {key.name}
              </td>
              <td className={`${cell} ${mono}`}>{key.prefix}</td>
              <td className={cell}>
                <DateCell iso={key.createdAt} />
              </td>
              <td className={cell}>
                {key.lastUsedAt === null ? (
                  t("neverUsed")
                ) : (
                  <DateCell iso={key.lastUsedAt} />
                )}
              </td>
              <td className={cell}>
                {key.expiresAt === null ? (
                  t("never")
                ) : (
                  <DateCell iso={key.expiresAt} />
                )}
              </td>
              <td className={cell}>
                <KeyStatus
                  revokedAt={key.revokedAt}
                  expiresAt={key.expiresAt}
                />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
