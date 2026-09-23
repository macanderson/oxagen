// The Organization tabs (mockup `pOrganization`, ARCHITECTURE.md §1.2): People,
// Roles, Invitations, Workspaces, Model funding and routes, Data plane and API
// keys, in that order, then Cost centers and Single sign-on, which the design
// does not draw and which stay reachable here. Each tab is a URL: Roles, API
// keys, Model funding and Single sign-on are routes of their own, and the rest
// are a `?tab=` value on `/{org}`, so a tab survives a reload and a shared
// link. A count follows a tab only where the frame read its rows, and it is
// the length of the table that tab draws.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { RouteTabs } from "@/ui/route-tabs";

export type OrganizationTab =
  | "people"
  | "roles"
  | "invitations"
  | "workspaces"
  | "modelFunding"
  | "dataPlane"
  | "apiKeys"
  | "costCenters"
  | "sso";

/** The rows behind the four counted tabs; a count the frame did not read is left off. */
export type TabCounts = Partial<
  Record<"people" | "roles" | "invitations" | "workspaces", number>
>;

export function OrganizationTabs({
  org,
  current,
  counts = {},
}: {
  org: string;
  current: OrganizationTab;
  counts?: TabCounts;
}) {
  const t = useTranslations("organization.tabs");
  const tab = (
    key: OrganizationTab,
    to: ReturnType<typeof routes.people>,
    count?: number,
  ) => ({
    to,
    label: t(key),
    current: current === key,
    ...(count === undefined ? {} : { count }),
  });
  return (
    <RouteTabs
      label={t("label")}
      tabs={[
        tab("people", routes.people(org), counts.people),
        tab("roles", routes.roles(org), counts.roles),
        tab(
          "invitations",
          routes.organization(org, "invitations"),
          counts.invitations,
        ),
        tab(
          "workspaces",
          routes.organization(org, "workspaces"),
          counts.workspaces,
        ),
        tab("modelFunding", routes.modelFunding(org)),
        tab("dataPlane", routes.organization(org, "dataPlane")),
        tab("apiKeys", routes.apiKeys(org)),
        tab("costCenters", routes.organization(org, "costCenters")),
        tab("sso", routes.sso(org)),
      ]}
    />
  );
}
