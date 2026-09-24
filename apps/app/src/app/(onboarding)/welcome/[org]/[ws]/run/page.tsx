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

type WelcomeRunPageProps = PageProps<"/welcome/[org]/[ws]/run">;

// Onboarding step 3, Start a run, in the gate shell. The step re-renders after
// every completed read of the first-frame wait, so each render carries a new
// poll revision and the instant it was made. The route params, the viewer and
// the query are request data, so they are read inside <Suspense> (Cache
// Components), and the clock and the revision are taken after them.
export default function WelcomeRunPage(props: WelcomeRunPageProps) {
  return (
    <Suspense fallback={<WelcomeLoading step="run" />}>
      <WelcomeRunStep {...props} />
    </Suspense>
  );
}

/** The request's clock and poll revision, read once per request outside render. */
function requestClock(): { now: number; pollRevision: string } {
  return { now: Date.now(), pollRevision: randomUUID() };
}

async function WelcomeRunStep({ params, searchParams }: WelcomeRunPageProps) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const agent = firstParam((await searchParams).agent) ?? null;
  const { now, pollRevision } = requestClock();
  return (
    <WelcomeRun
      ctx={ctx}
      source={dataSource()}
      agent={agent}
      now={now}
      pollRevision={pollRevision}
    />
  );
}
