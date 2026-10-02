import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  parseSteeringResult,
  SteeringConnectResult,
} from "@/features/onboarding";
import { firstParam } from "@/shared/safe-path";
import { AuthColumn, AuthShell, AuthSkeleton } from "@/ui/auth-shell";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("steeringConnect") };
}

type SteeringConnectResultPageProps = PageProps<"/github/steering/result">;

/**
 * Where a GitHub install ends when the browser can't open the Oxagen
 * organization that started it (#5151). The landing at `/github/steering`
 * sends a member on to the organization and everyone else here, so the
 * install never ends on a 404. It resolves no viewer: the landing already
 * did, and the page shows only the outcome the query names. The query is
 * request data, so it is read inside <Suspense> (Cache Components).
 */
export default function SteeringConnectResultPage(
  props: SteeringConnectResultPageProps,
) {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <SteeringConnectResultBody searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function SteeringConnectResultBody({
  searchParams,
}: {
  searchParams: SteeringConnectResultPageProps["searchParams"];
}) {
  const [query, pages] = await Promise.all([
    searchParams,
    getTranslations("pages"),
  ]);
  const result = parseSteeringResult(
    firstParam(query.steering),
    firstParam(query.code),
  );
  return (
    <AuthColumn>
      <PageHeader title={pages("steeringConnect")} />
      <SteeringConnectResult result={result} />
    </AuthColumn>
  );
}
