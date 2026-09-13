import Link from "next/link";
import { redirect } from "next/navigation";

import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AuthColumn,
  AuthHeading,
  AuthShell,
  AuthSkeleton,
  CliConsentForm,
  OutcomePanel,
  authorizeParamErrors,
  authorizeReturnPath,
  buttonSecondary,
  getAuthUser,
  loadCliScopes,
  readAuthorizeParams,
  withNext,
} from "@/features/auth";

// The authorize leg of the CLI's loopback OAuth + PKCE login (RFC 8252). A bad
// redirect_uri is never followed, not even to report an error: it renders here.
export default function CliAuthorizePage(props: PageProps<"/cli/authorize">) {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <CliAuthorize searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function CliAuthorize({
  searchParams,
}: {
  searchParams: PageProps<"/cli/authorize">["searchParams"];
}) {
  const params = readAuthorizeParams(await searchParams);
  const t = await getTranslations("auth.cli");
  const errors = authorizeParamErrors(params);
  if (errors.length > 0) {
    return (
      <AuthColumn>
        <AuthHeading kicker={t("title")} title={t("invalidTitle")} />
        <OutcomePanel
          tone="deny"
          testId="cli-invalid"
          title={t("invalidTitle")}
        >
          <p>{t("invalidBody")}</p>
          <ul className="mt-2 list-inside list-disc text-left">
            {errors.map((e) => (
              <li key={e}>{t(`invalid.${e}`)}</li>
            ))}
          </ul>
        </OutcomePanel>
      </AuthColumn>
    );
  }

  const user = await getAuthUser();
  if (!user) redirect(withNext("/login", authorizeReturnPath(params)));
  const orgs = await loadCliScopes(user.id);
  if (orgs.length === 0) {
    return (
      <AuthColumn>
        <AuthHeading kicker={t("title")} title={t("noScopeTitle")} />
        <OutcomePanel
          tone="neutral"
          testId="cli-no-scope"
          title={t("noScopeTitle")}
          actions={
            <Link href="/welcome" className={buttonSecondary}>
              {t("createOrganization")}
            </Link>
          }
        >
          {t("noScopeBody")}
        </OutcomePanel>
      </AuthColumn>
    );
  }
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("title")}
        title={t("title")}
        lead={t("lead", { label: params.label })}
      />
      <CliConsentForm params={params} orgs={orgs} />
    </AuthColumn>
  );
}
