"use client";
// The Connection tab's credential form (#4678, item 13): store a service
// secret, or an OAuth client's id and secret, under a name server.toml
// references as `oxagen:credential/<name>`.
//
// The value goes to the Oxagen vault through set_mcp_credential (#4742) and
// never to the steering folder, so a credential never reaches a steering PR.
// The form reads each value off its field at submit. It never holds one in
// state, never renders one back, and never puts one in a failure message. It
// clears the secret fields once the vault stores them. An operator's own
// OAuth sign-in is replaced through the Reconnect link beside this form.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import type { StudioAt } from "./route";
import {
  type SetMcpCredential,
  type SetMcpCredentialInput,
  setMcpCredential,
} from "./studio-calls";

type CredentialKind = SetMcpCredentialInput["kind"];

const KINDS = ["secret", "oauth_client"] as const satisfies readonly CredentialKind[];

/** Catalogue keys hold no underscore, so the kinds map here. */
const KIND_KEY = {
  secret: "secret",
  oauth_client: "oauthClient",
} as const satisfies Record<CredentialKind, string>;

/** The fields that hold a secret. The form empties them once stored. */
const SECRET_FIELDS = ["secret", "clientId", "clientSecret"] as const;

type Outcome =
  | { kind: "saved"; reference: string }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null };

function textOf(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement ? field.value : "";
}

/** The call's input, read off the form at submit. */
function credentialInput(
  form: HTMLFormElement,
  kind: CredentialKind,
): SetMcpCredentialInput {
  const name = textOf(form, "name").trim();
  return kind === "secret"
    ? { name, kind, secret: textOf(form, "secret") }
    : {
        name,
        kind,
        clientId: textOf(form, "clientId"),
        clientSecret: textOf(form, "clientSecret"),
      };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function CredentialForm({
  at,
  defaultName,
  defaultKind,
  credential = setMcpCredential,
}: {
  /** The workspace the credential is stored in. */
  at: StudioAt;
  /** The name the record references now, or "" when it names none. */
  defaultName: string;
  defaultKind: CredentialKind;
  credential?: SetMcpCredential;
}) {
  const t = useTranslations("mcpStudio.connection.auth");
  const id = useId();
  const [kind, setKind] = useState<CredentialKind>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setOutcome(null);
    try {
      const answer = await credential.call(at, credentialInput(form, kind));
      if (answer.ok) {
        for (const name of SECRET_FIELDS) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLInputElement) field.value = "";
        }
        setOutcome({ kind: "saved", reference: answer.reference });
      } else {
        setOutcome({ kind: "failed", code: answer.code });
      }
    } catch {
      setOutcome({ kind: "failed", code: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-testid="studio-credential-form"
      onSubmit={(event) => void submit(event)}
      className="flex w-full flex-col gap-3"
    >
      <fieldset className="flex min-w-0 flex-col gap-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-foreground">
            {t("kind")}
          </legend>
          <div className="flex flex-wrap gap-3">
            {KINDS.map((option) => (
              <label
                key={option}
                className="flex items-center gap-1.5 text-[13px] text-foreground"
              >
                <input
                  type="radio"
                  name="kind"
                  value={option}
                  checked={kind === option}
                  data-testid={`studio-credential-kind-${option}`}
                  onChange={() => {
                    setKind(option);
                  }}
                />
                {t(`kinds.${KIND_KEY[option]}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <Field id={`${id}-name`} label={t("name")} hint={t("nameHint")}>
          <input
            id={`${id}-name`}
            name="name"
            required
            maxLength={63}
            pattern="[a-z0-9][a-z0-9\-]{0,62}"
            defaultValue={defaultName}
            autoComplete="off"
            aria-describedby={`${id}-name-hint`}
            className={`${inputBase} ${mono}`}
          />
        </Field>
        {kind === "secret" ? (
          <Field id={`${id}-secret`} label={t("secret")} hint={t("secretHint")}>
            <input
              id={`${id}-secret`}
              name="secret"
              type="password"
              required
              autoComplete="new-password"
              aria-describedby={`${id}-secret-hint`}
              className={`${inputBase} ${mono}`}
            />
          </Field>
        ) : (
          <>
            <Field id={`${id}-client-id`} label={t("clientId")}>
              <input
                id={`${id}-client-id`}
                name="clientId"
                required
                autoComplete="off"
                className={`${inputBase} ${mono}`}
              />
            </Field>
            <Field
              id={`${id}-client-secret`}
              label={t("clientSecret")}
              hint={t("secretHint")}
            >
              <input
                id={`${id}-client-secret`}
                name="clientSecret"
                type="password"
                required
                autoComplete="new-password"
                aria-describedby={`${id}-client-secret-hint`}
                className={`${inputBase} ${mono}`}
              />
            </Field>
          </>
        )}
      </fieldset>
      {outcome === null ? null : outcome.kind === "saved" ? (
        <p
          role="status"
          data-testid="studio-credential-saved"
          className="text-[13px] text-foreground"
        >
          {t("saved", { reference: outcome.reference })}
        </p>
      ) : (
        <FormAlert testId="studio-credential-failed">
          {outcome.code === null
            ? t("thrown")
            : t("failed", { code: outcome.code })}
        </FormAlert>
      )}
      <button
        type="submit"
        aria-disabled={busy || undefined}
        data-capability={credential.name}
        data-testid="studio-credential-replace"
        className={`${buttonSecondary} self-start`}
      >
        {busy ? t("saving") : t("replace")}
      </button>
    </form>
  );
}
