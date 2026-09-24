import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AFTER_SIGNUP, AuthTags, SignupForm } from "@/features/auth";
import { readNext, routes } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("signup") };
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
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("signup.eyebrow")}
        title={pages("signup")}
        description={t("signup.lead")}
      />
      <SignupForm next={next} />
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
          t("shell.tags.allowance"),
          t("shell.tags.markup"),
          t("shell.tags.evidence"),
        ]}
      />
    </AuthColumn>
  );
}
