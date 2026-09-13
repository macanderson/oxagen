import Link from "next/link";

import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
  LoginForm,
  OAuthButtons,
  firstParam,
  linkText,
  sanitizeNext,
  withNext,
} from "@/features/auth";
import { isFixtureMode } from "@/server/fixture-session";

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
  const next = sanitizeNext(firstParam(params.next));
  const t = await getTranslations("auth");
  const fixture = isFixtureMode();
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("login.eyebrow")}
        title={t("login.title")}
        lead={t("login.lead")}
      />
      <div className="flex flex-col gap-4">
        {fixture ? null : <OAuthButtons callbackURL={next} />}
        <LoginForm next={next} fixture={fixture} />
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
