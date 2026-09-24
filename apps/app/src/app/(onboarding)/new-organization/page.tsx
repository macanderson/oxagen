import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  NewOrganizationLoading,
  NewOrganizationScreen,
} from "@/features/onboarding";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("newOrganization") };
}

// Onboarding step 1, Name your organization: the address the sign-up flow, the
// deprecated app, the docs and the GitHub setup fallback use, and the one
// `/welcome/organization` forwards to. The gate shell and the form are the
// whole page, and the form's h1 is its title. `?next=` (or the CLI's
// `?returnTo=`) is where a created organization continues to: the CLI consent
// page for an account made during `oxagen auth login`.
export default function NewOrganizationPage(
  props: PageProps<"/new-organization">,
) {
  return (
    <Suspense fallback={<NewOrganizationLoading />}>
      <NewOrganizationScreen searchParams={props.searchParams} />
    </Suspense>
  );
}
