import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { People, Workspaces } from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("people") };
}

export default async function OrganizationPage({
  params,
}: PageProps<"/[org]">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const t = await getTranslations("pages");
  const source = dataSource();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("organizationEyebrow", { organization: ctx.orgName })}
        title={t("people")}
      />
      <People ctx={ctx} source={source} />
      <Workspaces ctx={ctx} source={source} />
    </main>
  );
}
