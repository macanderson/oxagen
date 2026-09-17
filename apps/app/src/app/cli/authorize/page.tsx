import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  CliConsentForm,
  authorizeReturnPath,
  checkAuthorizeParams,
  loadConsentChoices,
  readAuthorizeParams,
} from "@/features/auth";
import { requireUser } from "@/server/viewer";
import { redirectTo } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";
import { AuthColumn, AuthShell, AuthSkeleton } from "@/ui/auth-shell";
import { OutcomePanel } from "@/ui/form-feedback";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("cliAuthorize") };
}

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
  const [t, pages] = await Promise.all([
    getTranslations("auth.cli"),
    getTranslations("pages"),
  ]);
  const checked = checkAuthorizeParams(params);
  if (!checked.ok) {
    return (
      <AuthColumn>
        <PageHeader title={pages("cliAuthorize")} />
        <OutcomePanel
          tone="deny"
          testId="cli-invalid"
          title={t("invalidTitle")}
        >
          <p>{t("invalidBody")}</p>
          <ul className="mt-2 list-inside list-disc text-left">
            {checked.errors.map((e) => (
              <li key={e}>{t(`invalid.${e}`)}</li>
            ))}
          </ul>
        </OutcomePanel>
      </AuthColumn>
    );
  }

  const returnPath = authorizeReturnPath(params);
  const ctx = await requireUser(returnPath);
  const choices = await loadConsentChoices(ctx, dataSource());
  if (!choices.ok) {
    return (
      <AuthColumn>
        <PageHeader title={pages("cliAuthorize")} />
        <OutcomePanel
          tone="deny"
          testId="cli-unavailable"
          title={t("errors.failed")}
        />
      </AuthColumn>
    );
  }
  // A brand-new account (`oxagen auth login --signup`, the desktop installer's
  // "Create an account", or a social sign-up that landed here) has nothing to
  // authorize yet: create the organization and its first workspace, then come
  // back to this consent page with the PKCE parameters intact.
  if (choices.value.length === 0)
    redirectTo(routes.newOrganization(returnPath));
  return (
    <AuthColumn>
      <PageHeader
        title={pages("cliAuthorize")}
        description={t("lead", { label: params.label })}
      />
      <CliConsentForm params={params} orgs={choices.value} />
    </AuthColumn>
  );
}
