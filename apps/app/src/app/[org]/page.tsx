import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import {
  CostCenters,
  People,
  Workspaces,
  OrganizationTabs,
  OrganizationHeader,
} from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("people") };
}

export default async function OrganizationPage({
  params,
  searchParams,
}: PageProps<"/[org]">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const query = await searchParams;
  const requested = firstParam(query.tab);
  const tab =
    requested === "invitations" ||
    requested === "workspaces" ||
    requested === "costCenters"
      ? requested
      : "people";
  const source = dataSource();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <OrganizationHeader ctx={ctx} source={source} />
      {tab === "people" || tab === "invitations" ? (
        <People ctx={ctx} source={source} view={tab} />
      ) : (
        <>
          <OrganizationTabs org={ctx.orgSlug} current={tab} />
          {tab === "workspaces" ? (
            <Workspaces ctx={ctx} source={source} />
          ) : (
            <CostCenters ctx={ctx} source={source} />
          )}
        </>
      )}
    </main>
  );
}
