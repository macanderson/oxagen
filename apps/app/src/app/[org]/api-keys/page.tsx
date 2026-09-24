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
import { requireViewer } from "@/server/viewer";

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
export default async function ApiKeysPage({
  params,
  searchParams,
}: PageProps<"/[org]/api-keys">) {
  const { org } = await params;
  const orgCtx = await requireViewer(org);
  const source = dataSource();
  const [query, workspaces] = await Promise.all([
    searchParams,
    source.org.workspaces(orgCtx),
  ]);
  const view = parseApiKeysView(query);
  const chosen = chooseWorkspace(workspaces, view.workspace);
  const ctx = chosen === null ? orgCtx : await requireViewer(org, chosen);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<OrganizationSkeleton />}>
        <OrganizationApiKeys
          ctx={orgCtx}
          keysCtx={ctx}
          source={source}
          workspaces={workspaces}
          view={view}
        />
      </Suspense>
    </main>
  );
}
