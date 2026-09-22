// Organization › Roles (ARCHITECTURE.md §1.2, ADR-063): the organization's
// roles with the permissions each one allows, who holds it and where it came
// from, and the permission catalogue the editor speaks. The read reports
// whether Oxagen resolves these grants for this organization's tier (§1.5),
// and the section says so either way rather than implying an enforcement the
// record does not carry. A refused or failed read replaces the sections; the
// tabs stay.
//
// Beside the catalogue sit the IdP group mappings (ADR-142): for each single
// sign-on provider, which organization role each identity provider group
// grants. They come from the SSO read, so a refused or failed SSO read says so
// in that section alone and leaves the roles in place.
import { useLocale, useTranslations } from "next-intl";
import type {
  Permission,
  Role,
  RoleCatalog,
  SsoSettings,
} from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { CreateRole, DeleteRole, EditRole } from "./role-actions";
import { SsoGroupRoles } from "./sso-group-roles";
import { OrganizationTabs } from "./tabs";

export async function Roles({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const [read, sso] = await Promise.all([
    source.org.roles(ctx),
    source.org.sso(ctx),
  ]);
  return (
    <RolesView
      org={ctx.orgSlug}
      canEdit={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      read={read}
      sso={sso}
    />
  );
}

const sectionTitle = "text-base font-semibold text-foreground";
const lead = "text-sm text-muted-foreground";

function RolesView({
  org,
  canEdit,
  read,
  sso,
}: {
  org: string;
  /** Owners and admins edit; the handler checks the role again. */
  canEdit: boolean;
  read: Read<RoleCatalog>;
  sso: Read<SsoSettings>;
}) {
  const t = useTranslations("organization.roleCatalog");
  return (
    <div className="flex flex-col gap-6">
      <OrganizationTabs org={org} current="roles" />
      {read.ok ? (
        <>
          <RoleTable org={org} canEdit={canEdit} value={read.value} />
          <Catalogue catalog={read.value.catalog} />
          <GroupMappings org={org} canEdit={canEdit} read={sso} />
        </>
      ) : (
        <ReadFailure read={read} section={t("title")} />
      )}
    </div>
  );
}

/** Whether Oxagen resolves this organization's grants, in the words the record supports. */
function Enforcement({
  enforcement,
}: {
  enforcement: RoleCatalog["enforcement"];
}) {
  const t = useTranslations("organization.roleCatalog.enforcement");
  return (
    <p data-enforced={enforcement.enforced ? "true" : "false"} className={lead}>
      {enforcement.enforced
        ? t("enforced")
        : t("recorded", { tier: enforcement.tier })}
    </p>
  );
}

function Origin({ role }: { role: Role }) {
  const t = useTranslations("organization.roleCatalog.origin");
  if (role.builtIn) return t("builtIn");
  return role.createdBy === null
    ? t("custom")
    : t("createdBy", { name: role.createdBy });
}

function RoleTable({
  org,
  canEdit,
  value,
}: {
  org: string;
  canEdit: boolean;
  value: RoleCatalog;
}) {
  const t = useTranslations("organization.roleCatalog");
  const tKind = useTranslations("organization.roleCatalog.kind");
  const tScope = useTranslations("organization.roleCatalog.scope");
  const tActions = useTranslations("organization.actions");
  const locale = useLocale();
  const columns = [
    { label: t("columns.role") },
    { label: t("columns.kind") },
    { label: t("columns.scope") },
    { label: t("columns.permissions") },
    { label: t("columns.heldBy"), numeric: true },
    { label: t("columns.origin") },
    ...(canEdit ? [{ label: t("columns.actions") }] : []),
  ];
  return (
    <section aria-labelledby="roles-table" className="flex flex-col gap-3">
      <h2 id="roles-table" className={sectionTitle}>
        {t("title")}
      </h2>
      <p className={lead}>{t("lead")}</p>
      <Enforcement enforcement={value.enforcement} />
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <CreateRole org={org} catalog={value.catalog} />
        </div>
      ) : (
        <p className={lead}>{tActions("readOnly")}</p>
      )}
      {value.roles.length === 0 ? (
        <p className={lead}>{t("empty")}</p>
      ) : (
        <Table label={t("tableLabel")} columns={columns}>
          {value.roles.map((role) => (
            <tr key={role.id} data-role={role.id}>
              <td className={cell}>
                <div className={`${mono} font-medium text-foreground`}>
                  {role.name}
                </div>
                {role.description === null ? null : (
                  <div className="text-muted-foreground">
                    {role.description}
                  </div>
                )}
              </td>
              <td className={cell}>{tKind(role.kind)}</td>
              <td className={cell}>{tScope(role.scope)}</td>
              <td className={cell}>
                {role.permissions.length === 0
                  ? t("noPermissions")
                  : role.permissions.join(", ")}
              </td>
              <td className={numericCell}>
                {formatCount(role.heldBy, locale)}
              </td>
              <td className={cell}>
                <Origin role={role} />
              </td>
              {canEdit ? (
                <td className={cell}>
                  {role.builtIn ? null : (
                    <div className="flex flex-wrap gap-2">
                      <EditRole org={org} role={role} catalog={value.catalog} />
                      <DeleteRole org={org} role={role} />
                    </div>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

function Catalogue({ catalog }: { catalog: readonly Permission[] }) {
  const t = useTranslations("organization.roleCatalog.catalog");
  const locale = useLocale();
  const groups = [...new Set(catalog.map((entry) => entry.group))];
  return (
    <section
      aria-labelledby="permission-catalogue"
      className={`${panel} flex flex-col gap-4 p-5`}
    >
      <div className="flex flex-col gap-0.5">
        <h2 id="permission-catalogue" className={sectionTitle}>
          {t("title")}
        </h2>
        <p className={lead}>{t("lead")}</p>
      </div>
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">{group}</h3>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            {catalog
              .filter((entry) => entry.group === group)
              .map((entry) => (
                <div
                  key={entry.permission}
                  data-permission={entry.permission}
                  className="contents"
                >
                  <dt className={`${mono} text-foreground`}>
                    {entry.permission}
                  </dt>
                  <dd className="text-muted-foreground">
                    {entry.description}{" "}
                    {t("covers", {
                      count: formatCount(entry.capabilities.length, locale),
                    })}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

/** Each SSO provider's table of IdP group to organization role. */
function GroupMappings({
  org,
  canEdit,
  read,
}: {
  org: string;
  canEdit: boolean;
  read: Read<SsoSettings>;
}) {
  const t = useTranslations("organization.ssoGroups");
  return (
    <section
      aria-labelledby="sso-group-mappings"
      className={`${panel} flex flex-col gap-4 p-5`}
      data-testid="sso-group-mappings"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id="sso-group-mappings" className={sectionTitle}>
          {t("title")}
        </h2>
        <p className={lead}>{t("lead")}</p>
      </div>
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : read.value.providers.length === 0 ? (
        <p className={lead} data-testid="sso-group-mappings-none">
          {t("noProviders")}{" "}
          <SafeLink to={routes.sso(org)} className={linkText}>
            {t("openSso")}
          </SafeLink>
        </p>
      ) : (
        read.value.providers.map((provider) => (
          <div key={provider.providerRef} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t("provider", {
                name: provider.displayName,
                domain: provider.domain,
              })}
            </h3>
            <SsoGroupRoles
              org={org}
              providerId={provider.providerRef}
              providerName={provider.displayName}
              mappings={provider.groupRoles}
              canEdit={canEdit}
            />
          </div>
        ))
      )}
    </section>
  );
}
