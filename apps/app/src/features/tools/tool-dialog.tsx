"use client";
// A registry row opens the tool dialog (mockup `tools.md`, "A row opens the
// tool dialog"): everything the record carries about the version, and, for an
// org Owner or Admin, the reclassification form.
//
// Four tabs, so a long description never pushes the record out of reach:
// Overview (the version at a glance and its description rendered as
// markdown), Examples (the worked inputs a provider writes into the
// description, as code), Details (the record's facts, the ids copyable), and
// Classification (the form). Every panel stays mounted while the dialog is
// open, so a half-filled form survives a look at another tab.
//
// The form sets the four axes the mandate gate and the class kill switches
// read — risk grade, side effect, egress, consequence tags — plus the data
// classes. The version's measures are carried through unchanged: a measure is
// a JSONPath into the tool's input, authored where the tool is declared or
// imported, and this page has no safe way to write one.
import { Check, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type McpServer,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
  type ToolVersion,
} from "@/data/contracts/tools";
import { CodeBlock } from "@/ui/code-panel";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { useNavigate } from "@/ui/navigation";
import { ProseMarkdown } from "@/ui/prose-markdown";
import { tabCount } from "@/ui/route-tabs";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { setToolClassification } from "./actions";
import { Chip, Fact, Facts, NotCarried, useDate } from "./parts";
import { ProviderIcon } from "./provider-icon";
import { GateDot, HazardCell } from "./registry-cells";
import { splitToolDescription, type ToolDescription } from "./tool-description";
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
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("classify.lead")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
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
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
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
            defaultValue={(version.classification?.dataClasses ?? []).join(
              "\n",
            )}
            placeholder={t("classify.dataClassesPlaceholder")}
            className={`${inputBase} ${mono}`}
          />
          <p className="text-xs text-muted-foreground">
            {t("classify.dataClassesHint")}
          </p>
        </div>
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
      <div className="flex justify-end">
        <SubmitButton
          pending={pending}
          label={t("classify.confirm")}
          pendingLabel={t("classify.pending")}
          fullWidth={false}
        />
      </div>
    </form>
  );
}

type ToolTab = "overview" | "examples" | "details" | "classification";

/** The tab style the Account dialog set, with room for a count. */
const TAB_CLASS =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:border-brand aria-selected:text-foreground";

/**
 * A value copied to the clipboard. The clipboard can refuse (an insecure
 * origin, a denied permission), and the refusal is said beside the button,
 * with the value still on screen to select by hand.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("tools.tool.copy");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="inline-flex flex-none items-center gap-1.5">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        title={label}
        className="grid size-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {state === "copied" ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <span role="status" className="text-[11px] text-muted-foreground">
        {state === "copied"
          ? t("copied")
          : state === "failed"
            ? t("failed")
            : ""}
      </span>
    </span>
  );
}

/** A record value in the mono face with its copy button. */
function Copyable({ text, label }: { text: string; label: string }) {
  return (
    <span className="flex items-start gap-2">
      <span className={`${mono} min-w-0 break-all pt-1`}>{text}</span>
      <CopyButton text={text} label={label} />
    </span>
  );
}

function Tile({
  term,
  wide = false,
  children,
}: {
  term: string;
  /** Spans both columns on a phone, so an odd tile out fills the row. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 bg-dialog-bg px-3 py-2.5 ${wide ? "col-span-2 sm:col-span-1" : ""}`}
    >
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">
        {children}
      </dd>
    </div>
  );
}

/** The five things a person decides on first, as the registry row shows them. */
function Glance({
  version,
  provider,
}: {
  version: ToolVersion;
  provider: McpServer | null;
}) {
  const registry = useTranslations("tools.registry");
  const locale = useLocale();
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
      <Tile term={registry("columns.provider")}>
        {provider !== null ? (
          provider.name
        ) : version.source === "mcp" ? (
          <NotCarried />
        ) : (
          registry(`declaredSource.${version.source}`)
        )}
      </Tile>
      <Tile term={registry("columns.hazard")}>
        <HazardCell version={version} />
      </Tile>
      <Tile term={registry("columns.gate")}>
        <GateDot version={version} />
      </Tile>
      <Tile term={registry("columns.egress")}>
        {version.classification === null
          ? registry("unclassified")
          : registry(`egress.${version.classification.egress}`)}
      </Tile>
      <Tile term={registry("columns.calls")} wide>
        {version.calls30d === null ? (
          <NotCarried />
        ) : (
          formatCount(version.calls30d, locale)
        )}
      </Tile>
    </dl>
  );
}

function Overview({
  version,
  provider,
  description,
  canClassify,
  onClassify,
}: {
  version: ToolVersion;
  provider: McpServer | null;
  description: ToolDescription | null;
  canClassify: boolean;
  onClassify: () => void;
}) {
  const t = useTranslations("tools.tool");
  const prose = description?.prose ?? "";
  const empty = prose === "" && (description?.examples.length ?? 0) === 0;
  return (
    <div className="flex flex-col gap-4">
      <Glance version={version} provider={provider} />
      {version.classification === null ? (
        <div
          data-testid="tool-unclassified"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5 text-sm text-foreground"
        >
          <p>{t("overview.unclassified")}</p>
          {canClassify ? (
            <button
              type="button"
              onClick={onClassify}
              className={buttonSecondary}
            >
              {t("overview.classify")}
            </button>
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {t("overview.noDescription")}
        </p>
      ) : prose === "" ? null : (
        <div data-testid="tool-description">
          <ProseMarkdown>{prose}</ProseMarkdown>
        </div>
      )}
    </div>
  );
}

function Examples({ description }: { description: ToolDescription }) {
  const t = useTranslations("tools.tool");
  const id = useId();
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t("examples.lead")}</p>
      {description.examples.map((example, index) => {
        const title =
          example.title ?? t("examples.untitled", { number: index + 1 });
        const heading = `${id}-example-${String(index)}`;
        return (
          <section
            // The list is parsed once from a fixed string and never reorders.
            key={heading}
            aria-labelledby={heading}
            data-tool-example=""
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 id={heading} className="text-[13.5px] font-semibold">
                {title}
              </h3>
              <CopyButton
                text={example.body}
                label={t("copy.example", { title })}
              />
            </div>
            <CodeBlock code={example.body} language={example.language} />
          </section>
        );
      })}
    </div>
  );
}

function Details({ version }: { version: ToolVersion }) {
  const t = useTranslations("tools.tool");
  const registry = useTranslations("tools.registry");
  const gates = useTranslations("tools.gate");
  const date = useDate();
  return (
    <Facts>
      <Fact name="id" term={t("facts.id")}>
        {/* The `tlv_…` a tool-version kill switch names (spec §6.11). It is
            printed because the switch dialog asks for it and this is the one
            place the registry can hand it over. */}
        <Copyable text={version.id} label={t("copy.id")} />
      </Fact>
      <Fact name="apiName" term={t("facts.apiName")}>
        <Copyable text={versionLabel(version)} label={t("copy.apiName")} />
      </Fact>
      <Fact name="capability" term={t("facts.capability")}>
        <Copyable text={version.capability} label={t("copy.capability")} />
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
        <Copyable text={version.schemaDigest} label={t("copy.digest")} />
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
  );
}

export function ToolDialog({
  at,
  version,
  canClassify,
  provider = null,
  children,
}: {
  at: ToolsAt;
  version: ToolVersion;
  canClassify: boolean;
  /** The provider an imported version came from: its name and its logo. */
  provider?: McpServer | null;
  /** The row's own cell content, which is what opens the dialog. */
  children: ReactNode;
}) {
  const t = useTranslations("tools.tool");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ToolTab>("overview");
  const id = useId();
  const tabsRef = useRef(new Map<ToolTab, HTMLButtonElement | null>());
  // Parsed only while the dialog is open: every registry row renders a
  // closed dialog, and a closed one reads nothing.
  const description = useMemo(
    () =>
      open && version.description !== null
        ? splitToolDescription(version.description)
        : null,
    [open, version.description],
  );
  const examples = description?.examples.length ?? 0;
  const tabs: readonly ToolTab[] =
    examples > 0
      ? ["overview", "examples", "details", "classification"]
      : ["overview", "details", "classification"];
  // A description refreshed while the dialog is open can lose its examples,
  // and then the tab it was on is gone. Overview stands in, so one tab is
  // always selected and one panel always shows.
  const current: ToolTab = tabs.includes(tab) ? tab : "overview";

  const select = (next: ToolTab) => {
    setTab(next);
    tabsRef.current.get(next)?.focus();
  };
  // The ARIA tabs pattern (see `account-dialog.tsx`): Left and Right move,
  // Home and End reach the ends, selection follows focus, and the strip is
  // one stop in the Tab order.
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + last) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    const next = tabs[target];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };
  const tabId = (name: ToolTab) => `${id}-tab-${name}`;
  const panelId = (name: ToolTab) => `${id}-panel-${name}`;
  const panel = (name: ToolTab, body: ReactNode) => (
    <div
      role="tabpanel"
      id={panelId(name)}
      aria-labelledby={tabId(name)}
      data-tool-panel={name}
      hidden={current !== name}
    >
      {body}
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTab("overview");
          setOpen(true);
        }}
        className="min-w-0 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={version.name}
        subtitle={versionLabel(version)}
        icon={
          <ProviderIcon
            name={provider?.name ?? version.name}
            iconUrl={provider?.iconUrl ?? null}
            size={36}
          />
        }
        wide="xl"
        testId="tool-dialog"
        tabs={
          <div
            role="tablist"
            aria-label={t("tabs.label")}
            className="-mb-px flex gap-0.5 overflow-x-auto border-b border-border"
          >
            {tabs.map((name, index) => (
              <button
                key={name}
                ref={(node) => {
                  tabsRef.current.set(name, node);
                }}
                type="button"
                role="tab"
                id={tabId(name)}
                aria-selected={current === name}
                aria-controls={panelId(name)}
                tabIndex={current === name ? 0 : -1}
                className={TAB_CLASS}
                onClick={() => {
                  setTab(name);
                }}
                onKeyDown={(event) => {
                  onTabKeyDown(event, index);
                }}
              >
                {t(`tabs.${name}`)}
                {name === "examples" ? (
                  <>
                    {" "}
                    <span className={tabCount}>{examples}</span>
                  </>
                ) : null}
              </button>
            ))}
          </div>
        }
      >
        {panel(
          "overview",
          <Overview
            version={version}
            provider={provider}
            description={description}
            canClassify={canClassify}
            onClassify={() => {
              select("classification");
            }}
          />,
        )}
        {description === null || examples === 0
          ? null
          : panel("examples", <Examples description={description} />)}
        {panel("details", <Details version={version} />)}
        {panel(
          "classification",
          canClassify ? (
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
          ),
        )}
      </SheetDialog>
    </>
  );
}
