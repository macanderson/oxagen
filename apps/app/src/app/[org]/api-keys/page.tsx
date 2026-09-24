import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  chooseWorkspace,
  OrganizationApiKeys,
  OrganizationSkeleton,
  parseApiKeysView,
} from "@/features/organization";
import { type OrgCtx, requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("apiKeys") };
}

// Organization › API keys (pages/organization-api-keys.md): the Organization
// page opened on its API keys tab. A key names a workspace (ADR-073), so the
// page does too: `?workspace=` picks one of the workspaces the viewer may
// enter, and the keys are read and written in that workspace's scope. With no
// such workspace the organization viewer is handed through and the section
// says why it lists nothing. `?show=` and `?offset=` carry the roster's filter
// and page on the same route; all three are parsed in one place
// (`api-keys-view.ts`), and a value the page does not understand falls back
// rather than failing the page.
//
// The route awaits only the organization viewer, which the layout already
// resolved, before its Suspense boundary. The workspaces read and the
// workspace viewer run inside it (`ApiKeysBody`), so the skeleton is on screen
// while they answer, as the design's loading state draws it; the layout's own
// fallback is empty.
export default async function ApiKeysPage({
  params,
  searchParams,
}: PageProps<"/[org]/api-keys">) {
  const { org } = await params;
  const orgCtx = await requireViewer(org);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<OrganizationSkeleton />}>
        <ApiKeysBody org={org} orgCtx={orgCtx} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** The reads that pick the workspace in scope, then the section over it. */
async function ApiKeysBody({
  org,
  orgCtx,
  searchParams,
}: {
  org: string;
  orgCtx: OrgCtx;
  searchParams: PageProps<"/[org]/api-keys">["searchParams"];
}) {
  const source = dataSource();
  const [query, workspaces] = await Promise.all([
    searchParams,
    source.org.workspaces(orgCtx),
  ]);
  const view = parseApiKeysView(query);
  const chosen = chooseWorkspace(workspaces, view.workspace);
  const ctx = chosen === null ? orgCtx : await requireViewer(org, chosen);
  return (
    <OrganizationApiKeys
      ctx={orgCtx}
      keysCtx={ctx}
      source={source}
      workspaces={workspaces}
      view={view}
    />
  );
}
