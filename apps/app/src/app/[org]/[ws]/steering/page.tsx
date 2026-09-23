import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import {
  Steering,
  SteeringCreate,
  parseSteeringView,
  steeringLink,
} from "@/features/steering";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("steering") };
}

// Records, Skills, proposals and the Context PR (#2961, ARCHITECTURE.md §1.2);
// a tab, a kind, a page, a selected proposal and a Skills cursor are query
// values on this one route. The header carries the tab's creation wizard.
export default async function SteeringPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const [t, query] = await Promise.all([
    getTranslations("pages"),
    searchParams,
  ]);
  const view = parseSteeringView(query);
  if (query.tab !== undefined)
    redirect(
      steeringLink({ org, ws }, { ...view, view: firstParam(query.view) }),
    );
  const st = await getTranslations("steering");
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
