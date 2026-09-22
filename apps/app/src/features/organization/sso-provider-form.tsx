"use client";
// Add or edit one identity provider (ADR-142). The fields follow the
// protocol: OIDC takes an issuer URL, a client ID and a client secret; SAML
// takes the IdP's entity ID, its SSO URL, its signing certificate and an
// optional SP private key.
//
// Secrets are write-only. Editing a provider shows whether one is stored and
// leaves the field blank; a blank field keeps the stored value. A refusal the
// action or the contract names on a field is shown under that field; any
// other refusal is shown once above the submit button.
import { useTranslations } from "next-intl";
import {
  type SyntheticEvent,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import type { SsoProtocol, SsoProvider } from "@/data/contracts/org";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { Field, PasswordField } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  createSsoProvider,
  type SsoProviderDraft,
  updateSsoProvider,
} from "./sso-actions";
import { SSO_UNANSWERED, type SsoFailure, useSsoFailure } from "./sso-failure";
import {
  DEFAULT_GROUPS_CLAIM,
  isSsoProtocol,
  SSO_PROTOCOLS,
} from "./sso-rules";

const fieldLabel = "text-sm font-medium text-foreground";
const hintText = "text-xs text-muted-foreground";

/** A labelled textarea with its hint and error wired like `Field`. */
function TextAreaField({
  id,
  label,
  hint,
  error,
  ...area
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <textarea
        id={id}
        rows={5}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputBase} font-mono text-xs`}
        {...area}
      />
      {error ? (
        <p id={errorId} className="text-sm text-error-ink">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className={hintText}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function emptyDraft(): SsoProviderDraft {
  return {
    protocol: "oidc",
    providerId: "",
    displayName: "",
    domain: "",
    groupsClaim: DEFAULT_GROUPS_CLAIM,
    issuer: "",
    clientId: "",
    clientSecret: "",
    entryPoint: "",
    cert: "",
    spPrivateKey: "",
  };
}

function draftOf(provider: SsoProvider): SsoProviderDraft {
  return {
    protocol: provider.protocol,
    providerId: provider.providerRef,
    displayName: provider.displayName,
    domain: provider.domain,
    groupsClaim: provider.groupsClaim,
    issuer: provider.issuer,
    clientId: provider.oidc?.clientRef ?? "",
    clientSecret: "",
    entryPoint: provider.saml?.entryPoint ?? "",
    cert: "",
    spPrivateKey: "",
  };
}

/**
 * The Add provider button and its dialog, or with `provider` the Edit button
 * and its dialog. The page re-reads after a save, so the table redraws from
 * the kernel rather than from this component's state.
 */
export function SsoProviderDialog({
  org,
  provider,
}: {
  org: string;
  provider?: SsoProvider;
}) {
  const t = useTranslations("organization.sso.form");
  const tProtocol = useTranslations("organization.sso.protocols");
  const failureText = useSsoFailure();
  const navigate = useNavigate();
  const editing = provider !== undefined;
  const initial = () => (provider ? draftOf(provider) : emptyDraft());

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SsoProviderDraft>(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SsoFailure | null>(null);

  const set =
    (key: keyof SsoProviderDraft) => (event: { target: { value: string } }) => {
      setDraft((d) => ({ ...d, [key]: event.target.value }));
    };

  const fieldError = (field: string) =>
    failure?.reason === "invalid" && failure.field === field
      ? failureText(failure)
      : undefined;

  const wholeFormFailure =
    failure && !(failure.reason === "invalid" && failure.field)
      ? failureText(failure)
      : null;

  function openChange(next: boolean) {
    setOpen(next);
    if (next) {
      setDraft(initial());
      setFailure(null);
    }
  }

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = provider
        ? await updateSsoProvider(org, {
            ...draft,
            stored: {
              issuer: provider.issuer,
              clientId: provider.oidc?.clientRef ?? "",
              entryPoint: provider.saml?.entryPoint ?? "",
            },
          })
        : await createSsoProvider(org, draft);
      if (result.ok) {
        // The secrets have done their job; they do not stay in memory.
        setDraft(emptyDraft());
        setOpen(false);
        navigate.refresh();
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(SSO_UNANSWERED);
    } finally {
      setPending(false);
    }
  }

  const idBase = editing ? `sso-edit-${provider.providerRef}` : "sso-add";
  const protocol: SsoProtocol = draft.protocol;

  return (
    <>
      <button
        type="button"
        className={editing ? buttonSecondary : buttonPrimary}
        onClick={() => {
          openChange(true);
        }}
        data-testid={`${idBase}-open`}
      >
        {editing ? t("edit") : t("add")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={
          editing
            ? t("editTitle", { name: provider.displayName })
            : t("addTitle")
        }
        closeLabel={t("cancel")}
        wide
        testId={idBase}
      >
        <form
          noValidate
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-4"
        >
          {editing ? null : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className={fieldLabel}>{t("protocol")}</legend>
              <div className="flex flex-wrap gap-4">
                {SSO_PROTOCOLS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="protocol"
                      value={p}
                      checked={protocol === p}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (!isSsoProtocol(value)) return;
                        setDraft((d) => ({ ...d, protocol: value }));
                        setFailure(null);
                      }}
                      className="size-4"
                    />
                    {tProtocol(p)}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <Field
            id={`${idBase}-provider-id`}
            name="providerId"
            label={t("providerId")}
            hint={t("providerIdHint")}
            autoComplete="off"
            spellCheck={false}
            value={draft.providerId}
            onChange={set("providerId")}
            readOnly={editing}
            error={fieldError("providerId")}
          />
          <Field
            id={`${idBase}-display-name`}
            name="displayName"
            label={t("displayName")}
            hint={t("displayNameHint")}
            value={draft.displayName}
            onChange={set("displayName")}
            error={fieldError("displayName")}
          />
          <Field
            id={`${idBase}-domain`}
            name="domain"
            label={t("domain")}
            hint={t("domainHint")}
            placeholder={t("domainPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            value={draft.domain}
            onChange={set("domain")}
            readOnly={editing}
            error={fieldError("domain")}
          />
          <Field
            id={`${idBase}-groups-claim`}
            name="groupsClaim"
            label={t("groupsClaim")}
            hint={t("groupsClaimHint")}
            spellCheck={false}
            value={draft.groupsClaim}
            onChange={set("groupsClaim")}
            error={fieldError("groupsClaim")}
          />

          {protocol === "oidc" ? (
            <>
              <Field
                id={`${idBase}-issuer`}
                name="issuer"
                type="url"
                inputMode="url"
                label={t("issuer")}
                hint={t("issuerHint")}
                placeholder={t("issuerPlaceholder")}
                value={draft.issuer}
                onChange={set("issuer")}
                error={fieldError("issuer")}
              />
              <Field
                id={`${idBase}-client-id`}
                name="clientId"
                label={t("clientId")}
                autoComplete="off"
                spellCheck={false}
                value={draft.clientId}
                onChange={set("clientId")}
                error={fieldError("clientId")}
              />
              <PasswordField
                id={`${idBase}-client-secret`}
                name="clientSecret"
                label={t("clientSecret")}
                autoComplete="off"
                spellCheck={false}
                value={draft.clientSecret}
                onChange={set("clientSecret")}
                hint={
                  editing
                    ? provider.oidc?.clientSecretSet === true
                      ? t("stored")
                      : t("notStored")
                    : undefined
                }
                error={fieldError("clientSecret")}
                showLabel={t("show")}
                hideLabel={t("hide")}
              />
            </>
          ) : (
            <>
              <Field
                id={`${idBase}-entity-id`}
                name="issuer"
                label={t("entityId")}
                spellCheck={false}
                value={draft.issuer}
                onChange={set("issuer")}
                error={fieldError("issuer")}
              />
              <Field
                id={`${idBase}-entry-point`}
                name="entryPoint"
                type="url"
                inputMode="url"
                label={t("entryPoint")}
                value={draft.entryPoint}
                onChange={set("entryPoint")}
                error={fieldError("entryPoint")}
              />
              <TextAreaField
                id={`${idBase}-cert`}
                name="cert"
                label={t("cert")}
                hint={editing ? t("certEditHint") : t("certHint")}
                placeholder={t("certPlaceholder")}
                value={draft.cert}
                onChange={set("cert")}
                error={fieldError("cert")}
              />
              <TextAreaField
                id={`${idBase}-sp-private-key`}
                name="spPrivateKey"
                label={t("spPrivateKey")}
                hint={
                  editing && provider.saml?.spPrivateKeySet === true
                    ? `${t("spPrivateKeyHint")} ${t("stored")}`
                    : t("spPrivateKeyHint")
                }
                autoComplete="off"
                value={draft.spPrivateKey}
                onChange={set("spPrivateKey")}
                error={fieldError("spPrivateKey")}
              />
            </>
          )}

          {wholeFormFailure === null ? null : (
            <FormAlert testId={`${idBase}-failure`}>
              {wholeFormFailure}
            </FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("save")}
            pendingLabel={t("saving")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
