import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  OrganizationRoles,
  OrganizationSkeleton,
} from "@/features/organization";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("roles") };
}

// Organization › Roles (pages/organization-roles.md): the Organization page
// opened on its Roles tab, a route of its own so a link lands on the roles.
export default async function RolesPage({ params }: PageProps<"/[org]/roles">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<OrganizationSkeleton />}>
        <OrganizationRoles ctx={ctx} source={dataSource()} />
      </Suspense>
    </main>
  );
}
