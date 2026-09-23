import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  resolveSteeringRoute,
  Steering,
  SteeringLoading,
} from "@/features/steering";
import { requireViewer } from "@/server/viewer";
import { redirectTo } from "@/shared/navigation";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("steering") };
}

// One Steering tab or Library shelf (roadmap pages/steering.md): Library,
// Assignments, Gates, Proposals and Compiler, and the shelves Records,
// Instructions, Skills, Memory and Ontology, each a path segment. An address
// written before the five tabs (policy, preview, prs, settings, deliveries,
// library/<shelf>) moves to where it lives now; a segment that names nothing
// is a 404. `/steering/records/<lineage>` is the record page, its own route.
export default async function SteeringViewPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/steering/[...view]">) {
  const { org, ws, view: segments } = await params;
  const ctx = await requireViewer(org, ws);
  const [t, st, query] = await Promise.all([
    getTranslations("pages"),
    getTranslations("steering.hub"),
    searchParams,
  ]);
  const route = resolveSteeringRoute(
    { org: ctx.orgSlug, ws: ctx.wsSlug },
    segments,
    query,
  );
  if (route.kind === "redirect") redirectTo(route.to);
  if (route.kind === "not_found") notFound();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Suspense fallback={<SteeringLoading />}>
        <Steering
          ctx={ctx}
          source={dataSource()}
          view={route.view}
          header={(actions) => (
            <PageHeader
              eyebrow={ctx.wsName}
              title={t("steering")}
              description={st("description")}
              actions={actions}
            />
          )}
        />
      </Suspense>
    </main>
  );
}
