// The Organization pages' tabs (ARCHITECTURE.md §1.2): People, Roles, API keys
// and Model funding are URL segments, so the tab survives a reload and a shared link. The
// tabs stay when a section's read fails; only the section body is replaced.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { RouteTabs } from "@/ui/route-tabs";

export type OrganizationTab = "people" | "roles" | "apiKeys" | "modelFunding";

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
          to: routes.apiKeys(org),
          label: t("apiKeys"),
          current: current === "apiKeys",
        },
        {
          to: routes.modelFunding(org),
          label: t("modelFunding"),
          current: current === "modelFunding",
        },
      ]}
    />
  );
}
