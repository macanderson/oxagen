// /new-organization as a Server Component: the signed-in person, then the
// organization form. A signed-out visitor is sent to /login and back here.
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthUser, withNext } from "@/features/auth";
import { AuthColumn, AuthHeading } from "@/ui/auth-shell";
import { OrganizationForm } from "./ui/organization-form";

export async function NewOrganizationScreen() {
  const user = await getAuthUser();
  if (!user) redirect(withNext("/login", "/new-organization"));
  const t = await getTranslations("onboarding.organization");
  return (
    <AuthColumn wide>
      <AuthHeading kicker={t("eyebrow")} title={t("title")} lead={t("lead")} />
      <OrganizationForm />
    </AuthColumn>
  );
}
