import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LoginForm, OAuthButtons, oauthQueryOutcome } from "@/features/auth";
import { firstParam, readNext, routes } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("login") };
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Login searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Login({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  const params = await searchParams;
  // Only a same-origin relative path survives; anything else lands on "/".
  const next = readNext(params);
  // Better Auth social failures land here as `?error=<code>` (errorCallbackURL
  // and the proxy lift from `/?error=`). Map once so LoginForm can show it.
  const initialOutcome = oauthQueryOutcome(firstParam(params.error));
  // requireViewer sends `?sso=required` when the organization requires single
  // sign-on and this session was not one; the SSO entry then starts open.
  const ssoRequired = firstParam(params.sso) === "required";
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("login.eyebrow")}
        title={pages("login")}
        description={t("login.lead")}
      />
      <div className="flex flex-col gap-4">
        <OAuthButtons callbackURL={next} />
        <LoginForm
          next={next}
          initialOutcome={initialOutcome}
          ssoRequired={ssoRequired}
        />
      </div>
      <AuthFooter>
        {t("login.newHere")}{" "}
        <SafeLink to={routes.signup(next)} className={linkText}>
          {t("login.createAccount")}
        </SafeLink>
      </AuthFooter>
      <AuthFooter>{t("login.haveInvite")}</AuthFooter>
    </AuthColumn>
  );
}
