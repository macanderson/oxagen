import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { Roles } from "@/features/organization";
import { requireViewer } from "@/server/viewer";
import { OrganizationHeader } from "@/features/organization";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("roles") };
}

export default async function RolesPage({ params }: PageProps<"/[org]/roles">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <OrganizationHeader ctx={ctx} source={dataSource()} />
      <Roles ctx={ctx} source={dataSource()} />
    </main>
  );
}
