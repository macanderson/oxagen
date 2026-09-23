// The Organization pages' tabs (ARCHITECTURE.md §1.2): People, Roles, API keys,
// Model funding and Single sign-on are URL segments, so the tab survives a reload and a shared link. The
// tabs stay when a section's read fails; only the section body is replaced.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { RouteTabs } from "@/ui/route-tabs";

export type OrganizationTab =
  | "people"
  | "roles"
  | "apiKeys"
  | "modelFunding"
  | "invitations"
  | "workspaces"
  | "costCenters"
  | "sso";

export function OrganizationTabs({
  org,
  current,
}: {
  org: string;
  current: OrganizationTab;
}) {
  const t = useTranslations("organization.tabs");
  return (
    <RouteTabs
      label={t("label")}
      tabs={[
        {
          to: routes.people(org),
          label: t("people"),
          current: current === "people",
        },
        {
          to: routes.roles(org),
          label: t("roles"),
          current: current === "roles",
        },
        {
          to: routes.organization(org, "invitations"),
          label: t("invitations"),
          current: current === "invitations",
        },
        {
          to: routes.organization(org, "workspaces"),
          label: t("workspaces"),
          current: current === "workspaces",
        },
        {
          to: routes.apiKeys(org),
          label: t("apiKeys"),
          current: current === "apiKeys",
        },
        {
          to: routes.modelFunding(org),
          label: t("modelFunding"),
          current: current === "modelFunding",
        },
        {
          to: routes.organization(org, "costCenters"),
          label: t("costCenters"),
          current: current === "costCenters",
        },
        {
          to: routes.sso(org),
          label: t("sso"),
          current: current === "sso",
        },
      ]}
    />
  );
}
