"use client";
// Pick the organization and workspace the CLI may act in, then approve or
// cancel. Presentation only: the actions re-validate everything.
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { approveCliAuth, cancelCliAuth } from "./cli-actions";
import type { CliAuthorizeParams, OrgOption } from "./cli-authorize";
import { FormAlert } from "./ui/feedback";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
  panel,
} from "./ui/styles";

function Hidden({ params }: { params: CliAuthorizeParams }) {
  return (
    <>
      <input type="hidden" name="redirect_uri" value={params.redirectUri} />
      <input type="hidden" name="state" value={params.state} />
      <input type="hidden" name="code_challenge" value={params.codeChallenge} />
      <input
        type="hidden"
        name="code_challenge_method"
        value={params.codeChallengeMethod}
      />
      <input type="hidden" name="label" value={params.label} />
    </>
  );
}

export function CliConsentForm({
  params,
  orgs,
}: {
  params: CliAuthorizeParams;
  orgs: OrgOption[];
}) {
  const t = useTranslations("auth.cli");
  const [orgSlug, setOrgSlug] = useState(orgs[0]?.slug ?? "");
  const org = orgs.find((o) => o.slug === orgSlug) ?? orgs[0];
  const workspaces = org?.workspaces ?? [];
  const [wsSlug, setWsSlug] = useState(workspaces[0]?.slug ?? "");
  const [approveState, approve, approving] = useActionState(
    approveCliAuth,
    null,
  );
  const [cancelState, cancel, cancelling] = useActionState(cancelCliAuth, null);
  const error = approveState?.error ?? cancelState?.error ?? null;
  const busy = approving || cancelling;

  return (
    <div className={`${panel} flex flex-col gap-5 p-5 sm:p-6`}>
      {error ? (
        <FormAlert testId="cli-error">
          {error === "invalid" ? t("invalidBody") : t(`errors.${error}`)}
        </FormAlert>
      ) : null}
      <form
        action={approve}
        className="flex flex-col gap-4"
        aria-label={t("title")}
      >
        <Hidden params={params} />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="cli-org"
            className="text-sm font-medium text-foreground"
          >
            {t("organization")}
          </label>
          <select
            id="cli-org"
            name="org_slug"
            className={inputBase}
            value={orgSlug}
            disabled={busy}
            onChange={(e) => {
              setOrgSlug(e.target.value);
              setWsSlug(
                orgs.find((o) => o.slug === e.target.value)?.workspaces[0]
                  ?.slug ?? "",
              );
            }}
          >
            {orgs.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="cli-ws"
            className="text-sm font-medium text-foreground"
          >
            {t("workspace")}
          </label>
          <select
            id="cli-ws"
            name="workspace_slug"
            className={`${inputBase} ${mono}`}
            value={wsSlug}
            disabled={busy || workspaces.length === 0}
            onChange={(e) => {
              setWsSlug(e.target.value);
            }}
          >
            {workspaces.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </select>
          {workspaces.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noWorkspaces")}</p>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
            {t("grantsTitle")}
          </p>
          <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-xs">
            <li>{t("grantKeys")}</li>
            <li>{t("grantActs")}</li>
          </ul>
        </div>
        <button
          type="submit"
          className={buttonPrimary}
          disabled={busy || !orgSlug || !wsSlug}
        >
          {approving ? t("approving") : t("approve")}
        </button>
      </form>
      <form action={cancel}>
        <Hidden params={params} />
        <button
          type="submit"
          className={`${buttonSecondary} w-full`}
          disabled={busy}
        >
          {cancelling ? t("cancelling") : t("cancel")}
        </button>
      </form>
    </div>
  );
}
