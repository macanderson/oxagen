import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { WelcomeLoading, WelcomeRun } from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("welcomeRun") };
}

// Onboarding step 3, Start a run, in the gate shell. The step re-renders after
// every completed read of the first-frame wait, so each render carries a new
// poll revision and the instant it was made.
export default async function WelcomeRunPage({
  params,
  searchParams,
}: PageProps<"/welcome/[org]/[ws]/run">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const agent = firstParam((await searchParams).agent) ?? null;
  return (
    <Suspense fallback={<WelcomeLoading step="run" />}>
      <WelcomeRun
        ctx={ctx}
        source={dataSource()}
        agent={agent}
        now={Date.now()}
        pollRevision={randomUUID()}
      />
    </Suspense>
  );
}
