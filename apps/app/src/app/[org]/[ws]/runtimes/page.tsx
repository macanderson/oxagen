import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireViewer } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("runtimes") };
}

// Runtimes (roadmap mockups/pages/runtimes.md): the hosts agents run on. The
// sidebar, the More sheet and ⌘K link here, so the route exists and keeps the
// shell around it (audit-prompt checks 1 and 4). The record holds one row per
// enrollment (one agent key on one machine), not a runtime per host, so the
// body says what is missing and where the enrollments are listed today
// (#3816). The Runtimes lane replaces this body with the page it builds.
export default async function RuntimesPage({
  params,
}: PageProps<"/[org]/[ws]/runtimes">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("runtimes")}
        description={t("runtimesDescription")}
      />
      <p
        data-testid="runtimes-not-backed"
        data-gap="#3816"
        className="max-w-prose text-sm text-muted-foreground"
      >
        {t("runtimesNotBacked")}{" "}
        <SafeLink
          to={routes.agents(ctx.orgSlug, ctx.wsSlug)}
          className={linkText}
        >
          {t("runtimesAgentsLink")}
        </SafeLink>
      </p>
    </main>
  );
}
