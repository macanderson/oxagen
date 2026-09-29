import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  Organization,
  OrganizationSkeleton,
  parseOrganizationTab,
  parseSlackOutcome,
} from "@/features/organization";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("people") };
}

// Organization (pages/organization.md): People, Invitations, Workspaces, Data
// plane, Cost centers and Notifications are a `?tab=` value on this route;
// Roles, API keys, Model funding and Single sign-on are routes of their own.
// `slack` is how a Slack connection attempt ended, set by the OAuth callback
// and read by Notifications only. The h1 is the
// organization's name, drawn by the page's header once the frame has checked
// the viewer may read it; while the reads run, the skeleton holds the body and
// the shell stays.
export default async function OrganizationPage({
  params,
  searchParams,
}: PageProps<"/[org]">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const query = await searchParams;
  const tab = parseOrganizationTab(query.tab);
  return (
    <Suspense fallback={<OrganizationSkeleton />}>
      <Organization
        ctx={ctx}
        source={dataSource()}
        tab={tab}
        slack={parseSlackOutcome(query.slack)}
      />
    </Suspense>
  );
}
