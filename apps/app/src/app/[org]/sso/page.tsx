import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Sso } from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("sso") };
}

// Organization › Single sign-on (ADR-144): the organisation's identity
// providers, the DNS records that prove their domains, and whether members
// must sign in through one. Org-scoped, so the page resolves the organization
// viewer and nothing else.
export default async function SsoPage({ params }: PageProps<"/[org]/sso">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("organizationEyebrow", { organization: ctx.orgName })}
        title={t("sso")}
      />
      <Sso ctx={ctx} source={dataSource()} />
    </main>
  );
}
