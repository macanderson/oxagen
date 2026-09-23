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

// Steering, the Library's All shelf (roadmap pages/steering.md). The five
// tabs and the shelves are path segments under this route
// (./[...view]/page.tsx); a `?tab=` link from the one-route page moves to the
// path it names. The header is drawn inside the body's boundary, because the
// loading, error and denied states replace it along with the body.
export default async function SteeringPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/steering">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const [t, st, query] = await Promise.all([
    getTranslations("pages"),
    getTranslations("steering.hub"),
    searchParams,
  ]);
  const route = resolveSteeringRoute(
    { org: ctx.orgSlug, ws: ctx.wsSlug },
    undefined,
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
