import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { NewOrganizationScreen } from "@/features/onboarding";
import { AuthColumn, AuthShell, AuthSkeleton } from "@/ui/auth-shell";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("newOrganization") };
}

// Create an organization: the address the deprecated app, the docs and the
// GitHub setup fallback use. The form is the whole page. `?next=` (or the
// CLI's `?returnTo=`) is where a created organization continues to: the CLI
// consent page for an account made during `oxagen auth login`.
export default function NewOrganizationPage(
  props: PageProps<"/new-organization">,
) {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <NewOrganization searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}

// The heading shares the screen's boundary, so a signed-out visitor sees the
// skeleton until the screen's sign-in gate redirects.
async function NewOrganization({
  searchParams,
}: {
  searchParams: PageProps<"/new-organization">["searchParams"];
}) {
  const [t, pages] = await Promise.all([
    getTranslations("onboarding.organization"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn wide>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={pages("newOrganization")}
        description={t("lead")}
      />
      <NewOrganizationScreen searchParams={searchParams} />
    </AuthColumn>
  );
}
