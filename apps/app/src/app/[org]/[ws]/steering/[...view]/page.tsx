import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import {
  Steering,
  SteeringCreate,
  parseSteeringView,
  steeringLink,
  steeringPathParams,
} from "@/features/steering";
import { redirectTo } from "@/shared/navigation";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("steering") };
}

export default async function SteeringSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string; view: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws, view: segments } = await params;
  const section = segments[0] ?? "";
  const allowed = [
    "library",
    "proposals",
    "freshness",
    "deliveries",
    "records",
    "skills",
    "memory",
    "settings",
    "prs",
  ];
  if (
    !allowed.includes(section) ||
    segments.length > 2 ||
    (segments.length === 2 && !["library"].includes(section))
  )
    notFound();
  if (
    section === "library" &&
    segments[1] &&
    !["all", "records", "skills", "memory"].includes(segments[1])
  )
    notFound();
  const ctx = await requireViewer(org, ws);
  const query = steeringPathParams(segments, await searchParams);
  const view = parseSteeringView(query);
  if (!["library", "proposals", "freshness", "deliveries"].includes(section))
    redirectTo(
      steeringLink({ org, ws }, { ...view, view: firstParam(query.view) }),
    );
  const [t, st] = await Promise.all([
    getTranslations("pages"),
    getTranslations("steering"),
  ]);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("steering")}
        description={st("description")}
        actions={<SteeringCreate searchParams={query} />}
      />
      <Steering ctx={ctx} source={dataSource()} searchParams={query} />
    </main>
  );
}
