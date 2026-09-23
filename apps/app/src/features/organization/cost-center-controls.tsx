"use client";
// The Cost centers section's controls (ADR-142): add a label, delete one, and
// change the label a workspace is charged to. Each reloads the page it
// changed.
import { useTranslations } from "next-intl";
import type { CostCenter, Workspace } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Field } from "@/ui/field";
import { useNavigate } from "@/ui/navigation";
import {
  createCostCenter,
  deleteCostCenter,
  setWorkspaceCostCenter,
} from "./cost-center-actions";
import { textValue, WriteDialog } from "./dialog";

const select =
  "min-h-10 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-input-fg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring";

export function AddCostCenter({ org }: { org: string }) {
  const t = useTranslations("organization.costCenters.add");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("open"),
        title: t("title"),
        confirm: t("confirm"),
        pending: t("pending"),
      }}
      testId="add-cost-center"
      submit={(form) =>
        createCostCenter(org, {
          label: textValue(form, "label"),
          description: textValue(form, "description"),
        })
      }
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <Field
        id="add-cost-center-label"
        name="label"
        label={t("label")}
        hint={t("labelHint")}
        required
      />
      <Field
        id="add-cost-center-description"
        name="description"
        label={t("description")}
      />
    </WriteDialog>
  );
}

export function DeleteCostCenter({
  org,
  costCenter,
}: {
  org: string;
  costCenter: CostCenter;
}) {
  const t = useTranslations("organization.costCenters.delete");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("open"),
        title: t("title", { label: costCenter.label }),
        confirm: t("confirm"),
        pending: t("pending"),
      }}
      testId={`delete-cost-center-${costCenter.id}`}
      submit={() => deleteCostCenter(org, costCenter.label)}
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <p className="text-sm">{t("body")}</p>
    </WriteDialog>
  );
}

export function ChargeWorkspace({
  org,
  workspace,
  costCenters,
}: {
  org: string;
  workspace: Workspace;
  costCenters: readonly CostCenter[];
}) {
  const t = useTranslations("organization.costCenters.charge");
  const navigate = useNavigate();
  const id = `charge-workspace-${workspace.id}`;
  return (
    <WriteDialog
      copy={{
        open: t("open"),
        title: t("title", { name: workspace.name }),
        confirm: t("confirm"),
        pending: t("pending"),
      }}
      testId={id}
      submit={(form) =>
        setWorkspaceCostCenter(org, workspace.slug, textValue(form, "label"))
      }
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <span className="flex flex-col gap-1 text-sm">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`${id}-label`}
        >
          {t("label")}
        </label>
        <select
          id={`${id}-label`}
          name="label"
          defaultValue={workspace.costCenter ?? ""}
          className={select}
        >
          <option value="">{t("none")}</option>
          {costCenters.map((center) => (
            <option key={center.id} value={center.label}>
              {center.label}
            </option>
          ))}
        </select>
      </span>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </WriteDialog>
  );
}
