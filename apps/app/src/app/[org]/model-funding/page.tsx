import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { ModelFunding } from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { OrganizationHeader } from "@/features/organization";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("modelFunding") };
}

// Organization › Model funding (ADR-053 §2): whose key pays for the in-app
// assistant's model calls. Org-scoped — the key pays for every workspace's
// turns — so the page resolves the organization viewer and nothing else.
export default async function ModelFundingPage({
  params,
}: PageProps<"/[org]/model-funding">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <OrganizationHeader ctx={ctx} source={dataSource()} />
      <ModelFunding ctx={ctx} source={dataSource()} />
    </main>
  );
}
