import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Skills, SkillsLoading } from "@/features/skills";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("skills") };
}

// The skills this workspace's harness sessions reported at start (#3098,
// ARCHITECTURE.md §1.2): one section, no tabs; a later page of the inventory
// is a query value on this route.
export default async function SkillsPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/skills">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const [pages, t, query] = await Promise.all([
    getTranslations("pages"),
    getTranslations("skills"),
    searchParams,
  ]);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        title={pages("skills")}
        eyebrow={t("eyebrow", { workspace: ctx.wsName })}
        description={t("lede")}
      />
      <Suspense fallback={<SkillsLoading />}>
        <Skills
          ctx={ctx}
          source={dataSource()}
          cursor={firstParam(query.cursor) ?? null}
        />
      </Suspense>
    </main>
  );
}
