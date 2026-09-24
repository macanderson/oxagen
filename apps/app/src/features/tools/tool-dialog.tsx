"use client";
// A registry row opens the tool dialog (mockup `tools.md`, "A row opens the
// tool dialog"): everything the record carries about the version, and, for an
// org Owner or Admin, the reclassification form.
//
// The form sets the four axes the mandate gate and the class kill switches
// read — risk grade, side effect, egress, consequence tags — plus the data
// classes. The version's measures are carried through unchanged: a measure is
// a JSONPath into the tool's input, authored where the tool is declared or
// imported, and this page has no safe way to write one.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import {
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
  type ToolVersion,
} from "@/data/contracts/tools";
import { inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { setToolClassification } from "./actions";
import { Chip, Fact, Facts, useDate } from "./parts";
import {
  splitLines,
  splitTags,
  textValue,
  type ToolsAt,
  versionLabel,
} from "./view";

const RISK_GRADES = ToolRiskGrade.options;
const SIDE_EFFECTS = ToolSideEffect.options;
const EGRESSES = ToolEgress.options;

/** A form value as the enum it must be, or the value the version already had. */
function choice<T extends string>(
  enumeration: { safeParse(value: unknown): { success: boolean; data?: T } },
  raw: string,
  fallback: T,
): T {
  const parsed = enumeration.safeParse(raw);
  return parsed.success && parsed.data !== undefined ? parsed.data : fallback;
}

function Select<T extends string>({
  id,
  label,
  options,
  defaultValue,
  optionLabel,
}: {
  id: string;
  label: string;
  options: readonly T[];
  defaultValue: T;
  optionLabel: (value: T) => string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <select
        id={id}
        name={id}
        defaultValue={defaultValue}
        className={inputBase}
      >
        {options.map((value) => (
          <option key={value} value={value}>
            {optionLabel(value)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ClassificationForm({
  at,
  version,
  onDone,
}: {
  at: ToolsAt;
  version: ToolVersion;
  onDone: () => void;
}) {
  const t = useTranslations("tools.tool");
  const registry = useTranslations("tools.registry");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const read = (key: string): string => textValue(form, key);
    setPending(true);
    setFailure(null);
    try {
      const result = await setToolClassification(at.org, at.ws, {
        toolVersionId: version.id,
        riskGrade: choice(ToolRiskGrade, read("riskGrade"), version.riskGrade),
        sideEffect: choice(
          ToolSideEffect,
          read("sideEffect"),
          version.classification?.sideEffect ?? "read",
        ),
        egress: choice(
          ToolEgress,
          read("egress"),
          version.classification?.egress ?? "local",
        ),
        consequenceTags: splitTags(read("consequenceTags")),
        // One class per line, never split on whitespace: a data class is free
        // text and `customer financial data` is one class, not three.
        dataClasses: splitLines(read("dataClasses")),
        measures: version.classification?.measures ?? [],
        reason: read("reason"),
      });
      if (result.ok) {
        onDone();
        // Refresh in place (#3800): the dialog is opened from the Tools list
        // and from the Providers tab, and a replace to the Tools root would
        // move a person who classified from Providers off that tab.
        navigate.refresh();
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("classify.lead")}</p>
      <Select
        id="riskGrade"
        label={t("classify.riskGrade")}
        options={RISK_GRADES}
        defaultValue={version.riskGrade}
        optionLabel={(value) => registry(`risk.${value}`)}
      />
      <Select
        id="sideEffect"
        label={t("classify.sideEffect")}
        options={SIDE_EFFECTS}
        defaultValue={version.classification?.sideEffect ?? "read"}
        optionLabel={(value) => registry(`sideEffect.${value}`)}
      />
      <Select
        id="egress"
        label={t("classify.egress")}
        options={EGRESSES}
        defaultValue={version.classification?.egress ?? "local"}
        optionLabel={(value) => registry(`egress.${value}`)}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="consequenceTags"
          className="text-sm font-medium text-foreground"
        >
          {t("classify.consequenceTags")}
        </label>
        <input
          id="consequenceTags"
          name="consequenceTags"
          defaultValue={(version.classification?.consequenceTags ?? []).join(
            " ",
          )}
          placeholder={t("classify.tagsPlaceholder")}
          className={`${inputBase} ${mono}`}
        />
        <p className="text-xs text-muted-foreground">
          {t("classify.tagsHint")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="dataClasses"
          className="text-sm font-medium text-foreground"
        >
          {t("classify.dataClasses")}
        </label>
        <textarea
          id="dataClasses"
          name="dataClasses"
          rows={3}
          defaultValue={(version.classification?.dataClasses ?? []).join("\n")}
          placeholder={t("classify.dataClassesPlaceholder")}
          className={`${inputBase} ${mono}`}
        />
        <p className="text-xs text-muted-foreground">
          {t("classify.dataClassesHint")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="reason" className="text-sm font-medium text-foreground">
          {t("classify.reason")}
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={2}
          required
          maxLength={500}
          className={inputBase}
        />
        <p className="text-xs text-muted-foreground">
          {t("classify.reasonHint")}
        </p>
      </div>
      {failure === null ? null : (
        <FormAlert testId="tool-classify-failure">{failure}</FormAlert>
      )}
      <SubmitButton
        pending={pending}
        label={t("classify.confirm")}
        pendingLabel={t("classify.pending")}
      />
    </form>
  );
}

export function ToolDialog({
  at,
  version,
  canClassify,
  children,
}: {
  at: ToolsAt;
  version: ToolVersion;
  canClassify: boolean;
  /** The row's own cell content, which is what opens the dialog. */
  children: ReactNode;
}) {
  const t = useTranslations("tools.tool");
  const registry = useTranslations("tools.registry");
  const gates = useTranslations("tools.gate");
  const date = useDate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="min-w-0 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={versionLabel(version)}
        testId="tool-dialog"
      >
        <div className="flex flex-col gap-4">
          {version.description === null ? null : (
            <p className="text-sm text-muted-foreground">
              {version.description}
            </p>
          )}
          <Facts>
            <Fact name="id" term={t("facts.id")}>
              {/* The `tlv_…` a tool-version kill switch names (spec §6.11). It
                  is printed because the switch dialog asks for it and this is
                  the one place the registry can hand it over. */}
              <span className={`${mono} break-all`}>{version.id}</span>
            </Fact>
            <Fact name="capability" term={t("facts.capability")}>
              <span className={mono}>{version.capability}</span>
            </Fact>
            <Fact name="source" term={t("facts.source")}>
              {t(`source.${version.source}`)}
            </Fact>
            <Fact name="gate" term={t("facts.gate")}>
              {gates(version.gate.kind)}
              {version.gate.switchId === null ? null : (
                <>
                  {" "}
                  <span className={mono}>{version.gate.switchId}</span>
                </>
              )}
            </Fact>
            <Fact name="origin" term={t("facts.origin")}>
              {registry(`origin.${version.schemaOrigin}`)}
            </Fact>
            <Fact name="digest" term={t("facts.digest")}>
              <span className={`${mono} break-all`}>
                {version.schemaDigest}
              </span>
            </Fact>
            <Fact name="readOnly" term={t("facts.readOnly")}>
              {version.readOnly ? t("yes") : t("no")}
            </Fact>
            <Fact name="enabled" term={t("facts.enabled")}>
              {version.enabled ? t("yes") : t("no")}
            </Fact>
            <Fact name="classifiedAt" term={t("facts.classifiedAt")}>
              {version.classifiedAt === null
                ? t("unclassified")
                : date(version.classifiedAt)}
            </Fact>
            {version.classification === null ||
            version.classification.measures.length === 0 ? null : (
              <Fact name="measures" term={t("facts.measures")}>
                <span className="flex flex-wrap gap-1">
                  {version.classification.measures.map((measure) => (
                    <Chip key={measure.name}>
                      {measure.name} {measure.path}
                    </Chip>
                  ))}
                </span>
              </Fact>
            )}
            <Fact name="updatedAt" term={t("facts.updatedAt")}>
              {date(version.updatedAt)}
            </Fact>
          </Facts>
          {canClassify ? (
            <ClassificationForm
              at={at}
              version={version}
              onDone={() => {
                setOpen(false);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("classify.denied")}
            </p>
          )}
        </div>
      </SheetDialog>
    </>
  );
}
