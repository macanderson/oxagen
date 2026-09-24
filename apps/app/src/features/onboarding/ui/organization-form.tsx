"use client";
// Onboarding step 1, Name your organization (mockup `obOrg`): the organization's
// name, its derived address and its namespace, then the first workspace's name
// and governance mode. The address follows the name and the workspace's address
// follows its name; the namespace follows the name until someone edits it.
// `create_org` stores the chosen namespace verbatim or refuses it as taken.
//
// A created organization continues to Wrap an agent, or to `destination` when
// the page was given one (the CLI consent page). A refusal the server names as
// a denial replaces the card with the gate's denied state, inside the shell.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono, panel } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { createOrganizationAction } from "../actions";
import {
  OrganizationForm as Schema,
  type OrganizationField,
  type OrgFormErrorKey,
  organizationFieldErrors,
  toNamespace,
  toSlug,
} from "../org-form";
import { GateFooter, GateHeader } from "./gate-shell";
import { GateDenied } from "./gate-states";

type Values = Record<OrganizationField, string>;
type FieldErrors = Partial<Record<OrganizationField, OrgFormErrorKey>>;
type Refusal = Extract<
  Awaited<ReturnType<typeof createOrganizationAction>>,
  { ok: false }
>;

const GOVERNANCE_MODES = ["solo", "team", "regulated"] as const;

/** The field errors a refusal names: a refused field, a taken address or namespace. */
function refusalFields(result: Refusal): FieldErrors {
  if (result.reason === "invalid")
    return organizationFieldErrors([
      { path: [result.field ?? ""], message: result.code },
    ]);
  if (result.reason === "conflict" && result.code === "slug_taken")
    return { slug: "slugTaken" };
  if (result.reason === "conflict" && result.code === "namespace_taken")
    return { namespace: "namespaceTaken" };
  return {};
}

// Phone inputs are 16px so iOS does not zoom on focus.
const phoneInput = "max-md:text-base";

export function OrganizationForm({
  initialName = "",
  destination,
  cancel,
  email,
  host,
}: {
  initialName?: string;
  /** A same-origin path, already sanitised by the screen, to go to instead of Wrap an agent. */
  destination?: SafePath;
  /** Where Cancel goes: nothing is written until Continue. */
  cancel: SafePath;
  /** The signed-in person, for the denied state. */
  email: string | null;
  /** The host the app is served on, for the address the organization gets. */
  host: string;
}) {
  const t = useTranslations("onboarding");
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>(() => ({
    name: initialName,
    slug: toSlug(initialName),
    namespace: toNamespace(initialName),
    workspaceName: "",
    workspaceSlug: "",
  }));
  const [namespaceTouched, setNamespaceTouched] = useState(false);
  const [governance, setGovernance] = useState<string>("team");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [pending, setPending] = useState(false);
  // The namespace the server refused, as it was sent: the alert names it even
  // after the field is edited, until the next submit.
  const [taken, setTaken] = useState<string | null>(null);

  function update(
    field: "name" | "namespace" | "workspaceName",
    value: string,
  ) {
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "name") {
        next.slug = toSlug(value);
        if (!namespaceTouched) next.namespace = toNamespace(value);
      }
      if (field === "workspaceName") next.workspaceSlug = toSlug(value);
      return next;
    });
    if (field === "namespace") setNamespaceTouched(true);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailed(false);
    setTaken(null);
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      setErrors(organizationFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await createOrganizationAction(values);
      if (result.ok) {
        navigate.push(destination ?? result.value.to);
        return;
      }
      if (result.reason === "denied") {
        setDenied(true);
        return;
      }
      const fields = refusalFields(result);
      if (fields.namespace === "namespaceTaken") setTaken(values.namespace);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  if (denied)
    return (
      <GateDenied
        org={null}
        permission={`org.create for ${email ?? "this account"}`}
        signedIn={email ?? "—"}
        back={cancel}
      />
    );

  const message = (key: OrgFormErrorKey | undefined) =>
    key === undefined || key === "namespaceTaken"
      ? undefined
      : t(`errors.${key}`);
  const nsMono = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;
  const namespace = values.namespace || "…";

  return (
    <form
      noValidate
      aria-label={t("organization.title")}
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-5"
    >
      <GateHeader
        eyebrow={t("organization.eyebrow")}
        title={t("organization.title")}
        lead={t("organization.lead")}
      />
      <div className={`${panel} flex flex-col gap-4 p-[18px] sm:p-5`}>
        {taken === null ? null : (
          <FormAlert testId="organization-namespace-taken">
            <span id="ob-ns-taken">
              {t.rich("organization.namespaceTaken", {
                namespace: taken,
                b: (chunks) => <b className="font-semibold">{chunks}</b>,
                ns: nsMono,
              })}
            </span>
          </FormAlert>
        )}
        {failed ? (
          <FormAlert testId="organization-failed">
            {t("errors.failed")}
          </FormAlert>
        ) : null}
        <Field
          id="ob-org"
          name="name"
          type="text"
          autoComplete="organization"
          label={t("organization.name")}
          value={values.name}
          onChange={(e) => {
            update("name", e.target.value);
          }}
          error={message(errors.name)}
          className={phoneInput}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            id="ob-url"
            name="slug"
            type="text"
            readOnly
            label={t("organization.address")}
            value={t("organization.addressValue", {
              host,
              slug: values.slug || "…",
            })}
            hint={t("organization.addressHint")}
            error={message(errors.slug)}
            className={`${phoneInput} bg-hl font-mono text-muted-foreground`}
          />
          <Field
            id="ob-ns"
            name="namespace"
            type="text"
            maxLength={6}
            spellCheck={false}
            autoCapitalize="none"
            label={t("organization.namespace")}
            value={values.namespace}
            onChange={(e) => {
              update("namespace", e.target.value);
            }}
            hint={t.rich("organization.namespaceHint", {
              namespace,
              b: (chunks) => (
                <b className="font-semibold text-foreground">{chunks}</b>
              ),
              k: nsMono,
            })}
            error={message(errors.namespace)}
            data-bad={errors.namespace === undefined ? undefined : "true"}
            {...(errors.namespace === "namespaceTaken"
              ? {
                  "aria-invalid": true,
                  "aria-describedby": "ob-ns-taken ob-ns-hint",
                }
              : {})}
            className={`${phoneInput} font-mono`}
          />
        </div>
        <div className="border-t border-border pt-4">
          <h2 className="mb-2.5 text-[13px] font-semibold text-foreground">
            {t("organization.workspaceTitle")}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              id="ob-ws"
              name="workspaceName"
              type="text"
              label={t("organization.workspaceName")}
              value={values.workspaceName}
              onChange={(e) => {
                update("workspaceName", e.target.value);
              }}
              error={message(errors.workspaceName ?? errors.workspaceSlug)}
              className={phoneInput}
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="ob-mode"
                className="text-sm font-medium text-foreground"
              >
                {t("organization.governance")}
              </label>
              <select
                id="ob-mode"
                name="governance"
                value={governance}
                aria-describedby="ob-mode-not-backed"
                onChange={(e) => {
                  setGovernance(e.target.value);
                }}
                className={`${inputBase} ${phoneInput}`}
              >
                {GOVERNANCE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`organization.governanceModes.${mode}`)}
                  </option>
                ))}
              </select>
              <p
                id="ob-mode-not-backed"
                data-testid="governance-not-backed"
                className="text-xs text-muted-foreground"
              >
                {t("organization.governanceNotBacked")}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {t("organization.workspaceHint")}
          </p>
        </div>
      </div>
      <GateFooter
        start={
          <SafeLink to={cancel} className={buttonSecondary}>
            {t("organization.cancel")}
          </SafeLink>
        }
        caption={t.rich("organization.creates", { namespace, ns: nsMono })}
        end={
          <SubmitButton
            pending={pending}
            label={t("organization.submit")}
            pendingLabel={t("organization.pending")}
            fullWidth={false}
          />
        }
      />
    </form>
  );
}
