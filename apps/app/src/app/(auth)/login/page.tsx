import Link from "next/link";

import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  LoginForm,
  OAuthButtons,
  sanitizeNext,
  nextParam,
  withNext,
} from "@/features/auth";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
} from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";

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
  const next = sanitizeNext(nextParam(params));
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
        <Link href={withNext("/signup", next)} className={linkText}>
          {t("login.createAccount")}
        </Link>
      </AuthFooter>
      <AuthFooter>{t("login.haveInvite")}</AuthFooter>
    </AuthColumn>
  );
}
