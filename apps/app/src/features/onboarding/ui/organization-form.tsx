"use client";
// Gate step 1 (mockup `obOrg` @ mc-baseline-w1): name the organization, its
// address and immutable namespace, and the first workspace. The address and
// namespace follow the name until someone edits them by hand.

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { Field } from "../../auth/ui/field";
import { FormAlert, SubmitButton } from "../../auth/ui/feedback";
import { eyebrow, panel } from "../../auth/ui/styles";
import { createOrganizationAction } from "../actions";
import { suggestNamespace, toSlug } from "../agent-key";
import {
  OrganizationForm as Schema,
  type OrganizationField,
  type OrgFormErrorKey,
} from "../org-form";

type Values = Record<OrganizationField, string>;

export function OrganizationForm({
  initialName = "",
}: {
  initialName?: string;
}) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => {
    const slug = toSlug(initialName);
    return {
      name: initialName,
      slug,
      namespace: suggestNamespace(slug),
      workspaceName: "",
      workspaceSlug: "",
    };
  });
  const [touched, setTouched] = useState<
    Partial<Record<OrganizationField, boolean>>
  >({});
  const [errors, setErrors] = useState<
    Partial<Record<OrganizationField, OrgFormErrorKey>>
  >({});
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  function update(field: OrganizationField, value: string) {
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "name" && !touched.slug) next.slug = toSlug(value);
      if ((field === "name" || field === "slug") && !touched.namespace)
        next.namespace = suggestNamespace(next.slug);
      if (field === "workspaceName" && !touched.workspaceSlug)
        next.workspaceSlug = toSlug(value);
      return next;
    });
    if (field === "slug" || field === "namespace" || field === "workspaceSlug")
      setTouched((prev) => ({ ...prev, [field]: true }));
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailed(false);
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<OrganizationField, OrgFormErrorKey>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as OrganizationField;
        next[field] ??= issue.message as OrgFormErrorKey;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await createOrganizationAction(values);
      if (result.ok) {
        router.push(result.to);
        return;
      }
      setErrors(result.fields ?? {});
      setFailed(result.error === "failed");
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const message = (field: OrganizationField) => {
    const key = errors[field];
    return key ? t(`errors.${key}`) : undefined;
  };
  const bind = (field: OrganizationField) => ({
    name: field,
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      update(field, e.target.value);
    },
    error: message(field),
  });

  return (
    <form
      noValidate
      aria-label={t("organization.title")}
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col"
    >
      <div className={`${panel} mt-5 flex flex-col gap-4 p-4 sm:p-5`}>
        {failed ? (
          <FormAlert testId="organization-failed">
            {t("errors.failed")}
          </FormAlert>
        ) : null}
        <Field
          id="org-name"
          type="text"
          autoComplete="organization"
          label={t("organization.name")}
          {...bind("name")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="org-slug"
            type="text"
            spellCheck={false}
            className="font-mono"
            label={t("organization.slug")}
            hint={t("organization.slugHint", { slug: values.slug || "…" })}
            {...bind("slug")}
          />
          <Field
            id="org-namespace"
            type="text"
            spellCheck={false}
            maxLength={6}
            className="font-mono"
            label={t("organization.namespace")}
            hint={t("organization.namespaceHint", {
              example: `${values.namespace || "…"}.<ws>.<agent>`,
            })}
            {...bind("namespace")}
          />
        </div>
        <div className="border-t border-border pt-4">
          <h2 className={`${eyebrow} mb-3`}>
            {t("organization.workspaceTitle")}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="ws-name"
              type="text"
              label={t("organization.workspaceName")}
              {...bind("workspaceName")}
            />
            <Field
              id="ws-slug"
              type="text"
              spellCheck={false}
              className="font-mono"
              label={t("organization.workspaceSlug")}
              {...bind("workspaceSlug")}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {t("organization.workspaceHint")}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2.5 sm:justify-end">
        <span className="text-xs text-muted-foreground">
          {t("organization.creates", { name: values.name || "…" })}
        </span>
        <SubmitButton
          pending={pending}
          label={t("organization.submit")}
          pendingLabel={t("organization.pending")}
          fullWidth={false}
        />
      </div>
    </form>
  );
}
