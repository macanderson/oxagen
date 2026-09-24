// Organization › Roles (pages/organization-roles.md, ADR-063): every role of
// the organization with its kind, its scope, the catalogue permissions it
// carries, who holds it and where it came from, and the role editor. The frame
// reads the catalogue once (`list_iam_roles`, every page of it) and hands it
// here.
//
// Held by reads the role's active assignments (`memberCount`): people for a
// human role, agents for an agent role, "nobody" at zero. `list_iam_roles`
// does not split a count between people, agents and keys, so a role is counted
// in the one unit its kind names, and the filters offer only the kinds and
// scopes a role can hold today (#3937).
//
// The read reports whether Oxagen resolves these grants for this
// organization's tier (ARCHITECTURE.md §1.5), and the tab says so under the
// note rather than implying an enforcement the record does not carry.
//
// Below the roles sit the IdP group mappings (ADR-145), which the design does
// not draw and which have no other home: for each single sign-on provider,
// which organization role each group grants. They come from the SSO read, so a
// refused or failed SSO read says so in that section alone.
import { useTranslations } from "next-intl";
import type { Role, RoleCatalog, SsoSettings } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  linkText,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { type ListRow, ListTable } from "./list-table";
import { note } from "./parts";
import { DeleteRole, RoleEditor } from "./role-actions";
import { SsoPlanNotice } from "./sso";
import { SsoGroupRoles } from "./sso-group-roles";

/** Permissions shown as chips before the rest collapse into "+N more". */
const CHIPS = 4;

const lead = "text-sm text-muted-foreground";
const sectionTitle = "text-base font-semibold text-foreground";

function Permissions({ role }: { role: Role }) {
  const t = useTranslations("organization.roleCatalog");
  if (role.permissions.length === 0) {
    return <span className="text-dim">{t("noPermissions")}</span>;
  }
  const rest = role.permissions.length - CHIPS;
  return (
    <span className="flex max-w-[30ch] flex-wrap gap-1">
      {role.permissions.slice(0, CHIPS).map((permission) => (
        <Badge key={permission} tone="quiet" dot={false} mono>
          {permission}
        </Badge>
      ))}
      {rest > 0 ? (
        <span className="text-[11px] text-dim">
          {t("more", { count: rest })}
        </span>
      ) : null}
    </span>
  );
}

function HeldBy({ role }: { role: Role }) {
  const t = useTranslations("organization.roleCatalog.heldBy");
  if (role.heldBy === 0) return <span className="text-dim">{t("nobody")}</span>;
  return (
    <span className="whitespace-nowrap">
      {role.kind === "human"
        ? t("people", { count: role.heldBy })
        : t("agents", { count: role.heldBy })}
    </span>
  );
}

function Origin({ role }: { role: Role }) {
  const t = useTranslations("organization.roleCatalog.origin");
  const format = useFormatter();
  if (role.builtIn) {
    return (
      <Badge tone="quiet" dot={false}>
        {t("builtIn")}
      </Badge>
    );
  }
  const date = format.dateTime(new Date(role.createdAt), {
    dateStyle: "medium",
  });
  return (
    <span className="text-[11.5px] text-dim">
      {role.createdBy === null
        ? t("createdAt", { date })
        : t("createdBy", { name: role.createdBy, date })}
    </span>
  );
}

export function RolesTab({
  org,
  catalog,
  sso,
}: {
  org: string;
  catalog: RoleCatalog;
  sso: Read<SsoSettings>;
}) {
  const t = useTranslations("organization.roleCatalog");
  const columns = [
    { label: t("columns.role") },
    { label: t("columns.kind") },
    { label: t("columns.scope") },
    { label: t("columns.permissions") },
    { label: t("columns.heldBy") },
    { label: t("columns.origin") },
    { label: t("columns.actions") },
  ];
  const rows: ListRow[] = catalog.roles.map((role) => ({
    key: role.id,
    rowId: role.id,
    search: `${role.name} ${role.description ?? ""} ${role.permissions.join(" ")}`,
    values: {
      kind: role.kind,
      scope: role.scope,
      origin: role.builtIn ? "builtIn" : "custom",
    },
    cells: [
      <span key="role">
        <span className={`${mono} text-[12.5px] font-medium text-foreground`}>
          {role.name}
        </span>
        {role.description === null ? null : (
          <span className="block text-[11.5px] text-dim">
            {role.description}
          </span>
        )}
      </span>,
      <Badge
        key="kind"
        tone={role.kind === "agent" ? "allowed" : "quiet"}
        dot={false}
      >
        {t(`kind.${role.kind}`)}
      </Badge>,
      <span key="scope" className={`${mono} text-[11.5px]`}>
        {t(`scope.${role.scope}`)}
      </span>,
      <Permissions key="permissions" role={role} />,
      <HeldBy key="held" role={role} />,
      <Origin key="origin" role={role} />,
      <div key="actions" className="flex flex-wrap gap-2">
        <RoleEditor
          org={org}
          catalog={catalog.catalog}
          role={role}
          mode={role.builtIn ? "view" : "edit"}
          openLabel={role.builtIn ? t("view") : t("edit")}
        />
        <RoleEditor
          org={org}
          catalog={catalog.catalog}
          role={role}
          mode="duplicate"
          openLabel={t("duplicate")}
        />
        <DeleteRole org={org} role={role} />
      </div>,
    ],
  }));
  return (
    <div className="flex flex-col gap-3.5">
      <section aria-labelledby="org-roles" className={panel}>
        <div className={panelHeader}>
          <h2 id="org-roles" className={panelTitle}>
            {t("title")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="quiet" dot={false} data-store="roles">
              {t("badge")}
            </Badge>
            <RoleEditor
              org={org}
              catalog={catalog.catalog}
              mode="create"
              openLabel={t("editor.create")}
              primary
            />
          </div>
        </div>
        <ListTable
          label={t("tableLabel")}
          columns={columns}
          rows={rows}
          filters={[
            {
              key: "kind",
              label: t("filters.kind"),
              options: [
                { value: "human", label: t("kind.human") },
                { value: "agent", label: t("kind.agent") },
              ],
            },
            {
              key: "scope",
              label: t("filters.scope"),
              options: [
                { value: "org", label: t("scope.org") },
                { value: "workspace", label: t("scope.workspace") },
              ],
            },
            {
              key: "origin",
              label: t("filters.origin"),
              options: [
                { value: "builtIn", label: t("originFilter.builtIn") },
                { value: "custom", label: t("originFilter.custom") },
              ],
            },
          ]}
          empty={catalog.roles.length === 0 ? t("empty") : t("noMatch")}
        />
        <div className={`${panelBody} flex flex-col gap-2`}>
          <p className={note}>{t("note")}</p>
          <Enforcement enforcement={catalog.enforcement} />
        </div>
      </section>
      <GroupMappings org={org} canEdit read={sso} />
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
    <p
      data-enforced={enforcement.enforced ? "true" : "false"}
      className="text-[12px] text-dim"
    >
      {enforcement.enforced
        ? t("enforced")
        : t("recorded", { tier: enforcement.tier })}
    </p>
  );
}

/**
 * Each SSO provider's table of IdP group to organization role. On a plan
 * without SSO the tables are read-only, because saving one sets SSO up.
 */
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
        read.value.entitled ? (
          <p className={lead} data-testid="sso-group-mappings-none">
            {t("noProviders")}{" "}
            <SafeLink to={routes.sso(org)} className={linkText}>
              {t("openSso")}
            </SafeLink>
          </p>
        ) : (
          <SsoPlanNotice org={org} hasProviders={false} />
        )
      ) : (
        <>
          {read.value.entitled ? null : (
            <SsoPlanNotice org={org} hasProviders />
          )}
          {read.value.providers.map((provider) => (
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
                canEdit={canEdit && read.value.entitled}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
