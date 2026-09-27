import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  parseSteeringResult,
  WelcomeFirstWorkspace,
  WelcomeLoading,
} from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("onboarding.welcome.workspace");
  return { title: t("pageTitle") };
}

type WelcomeFirstWorkspacePageProps = PageProps<"/welcome/[org]/new-workspace">;

// Onboarding step 3, Create the first workspace, in the gate shell. It names
// the workspace, then shows its steering repo's provisioning. Oxagen
// Steering's install on GitHub returns here with `?steering=` and `?code=`.
// The params, the viewer and the query are request data, so they are read
// inside <Suspense> (Cache Components) and the loading state is the
// prerendered shell.
export default function WelcomeFirstWorkspacePage(
  props: WelcomeFirstWorkspacePageProps,
) {
  return (
    <Suspense fallback={<WelcomeLoading step="workspace" />}>
      <WelcomeFirstWorkspaceStep {...props} />
    </Suspense>
  );
}

async function WelcomeFirstWorkspaceStep({
  params,
  searchParams,
}: WelcomeFirstWorkspacePageProps) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const query = await searchParams;
  const result = parseSteeringResult(
    firstParam(query.steering),
    firstParam(query.code),
  );
  return (
    <WelcomeFirstWorkspace ctx={ctx} source={dataSource()} result={result} />
  );
}
