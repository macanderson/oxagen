import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AFTER_SIGNUP,
  AuthTags,
  SignupForm,
  queryEmail,
  signupIncludesAllowance,
} from "@/features/auth";
import { readNext, routes } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";

// The one sign-in page whose document title is not its h1 (ARCHITECTURE.md
// §1.2): the h1 is the tagline, so the tab and a screen reader's window list
// name the page by its eyebrow, "Create your account".
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("signup.eyebrow") };
}

export default function SignupPage(props: PageProps<"/signup">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Signup searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Signup({
  searchParams,
}: {
  searchParams: PageProps<"/signup">["searchParams"];
}) {
  const params = await searchParams;
  const next = readNext(params, AFTER_SIGNUP);
  const [t, pages, allowance] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
    signupIncludesAllowance(),
  ]);
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("signup.eyebrow")}
        title={pages("signup")}
        description={t("signup.lead")}
      />
      {/* Verify email's Change it returns the address here, editable. */}
      <SignupForm next={next} email={queryEmail(params.email)} />
      <AuthFooter>
        {t("signup.haveAccount")}{" "}
        <SafeLink
          to={routes.login(next === AFTER_SIGNUP ? routes.root() : next)}
          className={linkText}
        >
          {t("signup.logIn")}
        </SafeLink>
      </AuthFooter>
      <AuthTags
        label={t("shell.tagsLabel")}
        tags={[
          // Drawn only when the Free plan, where a new organization starts,
          // includes governed actions (billing.plans).
          ...(allowance ? [t("shell.tags.allowance")] : []),
          t("shell.tags.markup"),
          t("shell.tags.evidence"),
        ]}
      />
    </AuthColumn>
  );
}
