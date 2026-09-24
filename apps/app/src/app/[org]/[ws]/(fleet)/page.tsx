import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import {
  Fleet,
  FLEET_PREFS_COOKIE,
  pullRequestFilterOf,
  readFleetPrefs,
} from "@/features/fleet";
import { OnboardingGate } from "@/features/onboarding";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("fleet") };
}

// The Fleet page (fleet.md in the roadmap's mockups). Fleet draws its own
// header, so a not-loaded state can replace the whole page body; the
// onboarding gate's banners sit under that header while the gate is open. It
// sits in the `(fleet)` route group so its loading skeleton scopes to this one
// route and not to every page under the workspace.
//
// The runs table's columns and page size are the person's saved choice, read
// from its cookie here so the first render draws the table they left.
export default async function FleetPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  const { cursor, prs } = await searchParams;
  const prefs = readFleetPrefs(
    (await cookies()).get(FLEET_PREFS_COOKIE)?.value,
  );
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <Fleet
        ctx={ctx}
        source={dataSource()}
        cursor={firstParam(cursor) ?? null}
        prefs={prefs}
        pullRequests={pullRequestFilterOf(firstParam(prs))}
        banners={<OnboardingGate ctx={ctx} source={dataSource()} />}
      />
    </main>
  );
}
