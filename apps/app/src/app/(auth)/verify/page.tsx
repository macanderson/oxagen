import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AFTER_SIGNUP, VerifyPanel, queryEmail } from "@/features/auth";
import { firstParam, readNext, routes } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("verify") };
}

export default function VerifyPage(props: PageProps<"/verify">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Verify searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Verify({
  searchParams,
}: {
  searchParams: PageProps<"/verify">["searchParams"];
}) {
  const params = await searchParams;
  const email = queryEmail(params.email);
  const expired = firstParam(params.error) !== undefined;
  const next = readNext(params, AFTER_SIGNUP);
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("verify.eyebrow")}
        title={pages("verify")}
        description={
          email
            ? t.rich("verify.lead", {
                email,
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })
            : t("verify.leadNoEmail")
        }
      />
      <VerifyPanel email={email} expired={expired} next={next} />
      <AuthFooter>
        {t("verify.wrongAddress")}{" "}
        {/* Back to sign-up with the address in its field, editable (verify-email.md). */}
        <SafeLink
          to={routes.signup(next === AFTER_SIGNUP ? undefined : next, {
            email: email ?? undefined,
          })}
          className={linkText}
        >
          {t("verify.changeIt")}
        </SafeLink>
      </AuthFooter>
    </AuthColumn>
  );
}
