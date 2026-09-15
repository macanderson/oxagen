import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LoginForm, OAuthButtons } from "@/features/auth";
import { readNext, routes } from "@/shared/safe-path";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
} from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

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
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("login.eyebrow")}
        title={t("login.title")}
        lead={t("login.lead")}
      />
      <div className="flex flex-col gap-4">
        <OAuthButtons callbackURL={next} />
        <LoginForm next={next} />
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
