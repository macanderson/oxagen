import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  parseSteeringResult,
  WelcomeConnect,
  WelcomeLoading,
} from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("onboarding.welcome.connect");
  return { title: t("pageTitle") };
}

type WelcomeConnectPageProps = PageProps<"/welcome/[org]/new-workspace/connect">;

// Onboarding step 2, Connect a code host, in the gate shell. The organization
// exists and has no workspace yet, so the route carries the organization
// alone. GitHub's install returns here with `?steering=` and `?code=`, which
// the step shows as its result line. The params, the viewer and the query are
// request data, so they are read inside <Suspense> (Cache Components) and the
// loading state is the prerendered shell.
export default function WelcomeConnectPage(props: WelcomeConnectPageProps) {
  return (
    <Suspense fallback={<WelcomeLoading step="connect" />}>
      <WelcomeConnectStep {...props} />
    </Suspense>
  );
}

async function WelcomeConnectStep({
  params,
  searchParams,
}: WelcomeConnectPageProps) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  const query = await searchParams;
  const result = parseSteeringResult(
    firstParam(query.steering),
    firstParam(query.code),
  );
  return <WelcomeConnect ctx={ctx} result={result} />;
}
