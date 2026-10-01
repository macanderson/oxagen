// The Organization tabs (mockup `pOrganization`, ARCHITECTURE.md §1.2): People,
// Roles, Invitations, Workspaces, Model funding and routes, Data plane and API
// keys, the seven the design draws, in that order, then Notifications (#4608),
// where an Owner or Admin picks the Slack channel steering repo health notices
// post to. Each tab is a URL: Roles, API keys and Model funding are routes of
// their own, and the rest are a `?tab=` value on `/{org}`, so a tab survives a
// reload and a shared link. A count follows a tab only where the frame read its
// rows, and it is the length of the table that tab draws.
//
// The row is a `RouteTabs` row (ADR-NEW-route-tabs-are-tabs): a tablist of
// links with one tab stop and the arrow keys. The selected tab names the panel
// the page draws under the row (`ORGANIZATION_PANEL`).
//
// Cost centers and Single sign-on are not in the design's row. Their pages
// keep rendering under this row with no tab selected, so their bodies are no
// tab's panel (`inOrganizationRow`): Single sign-on is linked from the IdP
// group mappings on Roles, and Cost centers keeps its URL
// (`/{org}?tab=costCenters`) until the design gives it a home.
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
  | "sso"
  | "notifications";

/** The id of the panel an Organization page draws under the row. */
export const ORGANIZATION_PANEL = "organization-panel";

/** Whether the row draws `tab`; Cost centers and Single sign-on render under it unselected. */
export function inOrganizationRow(tab: OrganizationTab): boolean {
  return tab !== "costCenters" && tab !== "sso";
}

/** The rows behind the four counted tabs; a count the frame did not read is left off. */
type TabCounts = Partial<
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
    name: key,
    ...(count === undefined ? {} : { count }),
  });
  return (
    <RouteTabs
      label={t("label")}
      panel={ORGANIZATION_PANEL}
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
        tab("notifications", routes.notifications(org)),
      ]}
    />
  );
}
