// /new-organization as a Server Component: the signed-in person, then the
// organization form. A signed-out visitor is sent to /login and back here.
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  DEFAULT_NEXT,
  getAuthUser,
  nextParam,
  sanitizeNext,
  withNext,
} from "@/features/auth";
import { AuthColumn, AuthHeading } from "@/ui/auth-shell";
import { OrganizationForm } from "./ui/organization-form";

export async function NewOrganizationScreen({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Where a created organization continues to. /cli/authorize sends a new
  // account here with itself as the destination, so the CLI's PKCE round trip
  // finishes; with none, the form lands on the new workspace's Fleet page.
  const next = sanitizeNext(nextParam(await searchParams));
  const user = await getAuthUser();
  if (!user) redirect(withNext("/login", withNext("/new-organization", next)));
  const t = await getTranslations("onboarding.organization");
  return (
    <AuthColumn wide>
      <AuthHeading kicker={t("eyebrow")} title={t("title")} lead={t("lead")} />
      <OrganizationForm
        destination={next === DEFAULT_NEXT ? undefined : next}
      />
    </AuthColumn>
  );
}
