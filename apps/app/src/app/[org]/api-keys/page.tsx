import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { ApiKeys, chooseWorkspace } from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("apiKeys") };
}

// Organization › API keys. A key names a workspace (ADR-069), so the page does
// too: `?workspace=` picks one of the workspaces the viewer may enter, and the
// keys are read and written in that workspace's scope. With no such workspace
// the organization viewer is handed through and the section says why it lists
// nothing.
export default async function ApiKeysPage({
  params,
  searchParams,
}: PageProps<"/[org]/api-keys">) {
  const { org } = await params;
  const orgCtx = await requireViewer(org);
  const source = dataSource();
  const [{ workspace }, workspaces] = await Promise.all([
    searchParams,
    source.org.workspaces(orgCtx),
  ]);
  const chosen = chooseWorkspace(workspaces, firstParam(workspace));
  const ctx = chosen === null ? orgCtx : await requireViewer(org, chosen);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("apiKeys")} />
      <ApiKeys ctx={ctx} source={source} workspaces={workspaces} />
    </main>
  );
}
