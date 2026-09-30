import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  OrganizationModelFunding,
  OrganizationSkeleton,
} from "@/features/organization";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("modelFunding") };
}

// Organization › Model funding and routes (pages/organization.md): the
// Organization page opened on that tab, a route of its own so a link lands on
// it. Which key pays for Oxagen's own model calls (ADR-053, ADR-131) and the
// route each tier takes. Org-scoped: the key pays for every workspace's turns.
// While the reads run, the skeleton holds the body and the shell stays.
export default async function ModelFundingPage({
  params,
}: PageProps<"/[org]/model-funding">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return (
    <Suspense fallback={<OrganizationSkeleton />}>
      <OrganizationModelFunding ctx={ctx} source={dataSource()} />
    </Suspense>
  );
}
