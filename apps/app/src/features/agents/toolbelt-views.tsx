"use client";
// The Toolbelt tab's three interactive panels: the model view with its
// presentation toggle, the belt search, and the per-tool decision rules with
// their layout toggle, category chips and the tool and categories dialogs.
//
// The presentation toggle is a preview and not a setting: it changes what
// this panel draws and nothing about how the agent runs. It starts on the
// presentation the belt recorded, and its state lives in this component, so
// opening another agent (a new page) starts it again from that agent's record.
//
// The search matches the names on this belt. Every query word has to appear,
// and a tool name is split on its separators first, so "stripe payment" finds
// `stripe__create_payment`. The same rule is run over the tools off the belt,
// so a miss can say whether the tool exists in the registry and why it is
// off. A search never returns a tool outside the belt.
import { useLocale, useTranslations } from "next-intl";
import { type SubmitEvent, useMemo, useState } from "react";
import type { Toolbelt } from "@/data/contracts/agents";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, headCell } from "@/ui/table";
import { NotBacked, NotRecordedValue, Note, Panel } from "./parts";
import { ToolSchema } from "./tool-schema";

type BeltTool = Toolbelt["tools"][number];
type OffTool = Toolbelt["cannotSee"][number];
type Mode = Toolbelt["presentation"]["mode"];

const pressed =
  "aria-pressed:border-foreground aria-pressed:bg-hl aria-pressed:text-foreground";

/** Two buttons in a labelled group, each with `aria-pressed` (the mockup's `.seg`). */
function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={`${buttonSecondary} ${pressed}`}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ModelView({ belt }: { belt: Toolbelt }) {
  const t = useTranslations("agents.detail.toolbelt.model");
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>(belt.presentation.mode);
  const count = belt.tools.length;
  const limit = belt.presentation.limit;
  const block =
    mode === "searchable"
      ? [
          `// ${t("block.searchable")}`,
          "[",
          '  { "name": "search_tools" },',
          '  { "name": "load_tools" }',
          "]",
        ].join("\n")
      : [
          `// ${t("block.full", { count: formatCount(count, locale) })}`,
          "[",
          ...belt.tools.map(
            (tool, index) =>
              `  { "name": ${JSON.stringify(tool.name)}, "input_schema": { /* ${tool.schemaDigest === null ? t("block.noSchema") : `sha256:${tool.schemaDigest.slice(0, 12)}`} */ } }${index === belt.tools.length - 1 ? "" : ","}`,
          ),
          "]",
        ].join("\n");
  return (
    <Panel
      id="belt-model"
      title={t("title")}
      lead={t(count > limit ? "over" : "under", {
        count: formatCount(count, locale),
        limit: formatCount(limit, locale),
        mode: belt.presentation.mode,
      })}
      aside={
        <Segmented
          label={t("toggle")}
          value={mode}
          options={[
            { value: "searchable", label: t("searchable") },
            { value: "full", label: t("full") },
          ]}
          onChange={setMode}
        />
      }
    >
      <Note>
        <b>{t(`${mode}Lead`)}</b> {t(`${mode}Body`)}
      </Note>
      <pre
        data-testid="belt-block"
        data-mode={mode}
        className={`${mono} max-h-80 overflow-auto rounded-lg bg-code-bg px-3 py-2 text-[12px] leading-5`}
      >
        {block}
      </pre>
      <NotBacked gap="tool_definition_trailer">{t("trailer")}</NotBacked>
    </Panel>
  );
}

/** Lower case, with a tool name's separators turned into spaces. */
function hay(text: string): string {
  return text.toLowerCase().replace(/[_@.:/-]+/g, " ");
}

function matches(words: readonly string[], text: string): boolean {
  const h = hay(text);
  return words.every((word) => h.includes(word));
}

const SEARCH_EXAMPLES = [
  "pull request",
  "context record",
  "stripe payment",
  "delete repository",
  "graph",
] as const;

export function BeltSearch({ belt }: { belt: Toolbelt }) {
  const t = useTranslations("agents.detail.toolbelt.search");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [ran, setRan] = useState<string | null>(null);
  const words = (ran ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits =
    ran === null || words.length === 0
      ? []
      : belt.tools.filter((tool) =>
          matches(
            words,
            `${tool.name} ${tool.server ?? ""} ${tool.category ?? ""}`,
          ),
        );
  const outside: OffTool | null =
    ran === null || words.length === 0
      ? null
      : (belt.cannotSee.find((tool) => matches(words, tool.name)) ?? null);

  function run(text: string) {
    setQuery(text);
    setRan(text);
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    run(query);
  }

  return (
    <Panel id="belt-search" title={t("title")} lead={t("lead")}>
      <form
        role="search"
        onSubmit={submit}
        className="flex items-center gap-2 rounded-lg border border-border bg-hl px-3 py-1.5"
      >
        <span className={`${mono} text-dim`} aria-hidden="true">
          {t("call")}
        </span>
        <input
          type="text"
          value={query}
          placeholder={t("placeholder")}
          aria-label={t("label")}
          className={`${inputBase} border-0 bg-transparent px-1 max-md:text-base`}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <span className={`${mono} text-dim`} aria-hidden="true">
          )
        </span>
        <button type="submit" className={buttonSecondary}>
          {t("run")}
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t("try")}</span>
        {SEARCH_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className={buttonSecondary}
            onClick={() => {
              run(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>
      {ran === null || words.length === 0 ? null : hits.length > 0 ? (
        <div data-testid="belt-hits" className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {hits.slice(0, 8).map((tool) => (
              <li key={tool.name} className="flex flex-col px-3 py-2">
                <span className={`${mono} break-all`}>{tool.name}</span>
                <span className="text-xs text-muted-foreground">
                  {tool.category ?? t("noCategory")}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t("matched", {
              hits: formatCount(hits.length, locale),
              total: formatCount(belt.tools.length, locale),
            })}
          </p>
        </div>
      ) : (
        <div
          data-testid="belt-miss"
          className="rounded-lg border border-border px-3 py-2 text-[13px]"
        >
          <b>{t("zero")}</b>{" "}
          {outside === null ? (
            t("nothing")
          ) : (
            <>
              {t("outside", { tool: outside.name })}{" "}
              <span className={mono}>{outside.rule}</span>
            </>
          )}
          <p className="mt-2 text-proven">{t("never")}</p>
        </div>
      )}
    </Panel>
  );
}

const NO_CATEGORY = "";

function ToolDialog({
  tool,
  onClose,
}: {
  tool: BeltTool | null;
  onClose: () => void;
}) {
  const t = useTranslations("agents.detail.toolbelt.rules");
  return (
    <SheetDialog
      open={tool !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tool?.name ?? ""}
      subtitle={tool?.server ?? undefined}
      wide
      testId="belt-tool-dialog"
    >
      {tool === null ? null : (
        <div className="flex flex-col gap-3 text-[13px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("columns.decision")}</dt>
            <dd>{t(`decision.${tool.decision}`)}</dd>
            <dt className="text-muted-foreground">{t("rule")}</dt>
            <dd className={mono}>{tool.rule}</dd>
            <dt className="text-muted-foreground">{t("columns.hazard")}</dt>
            <dd>
              {t("hazard", {
                risk: tool.riskLevel,
                access: tool.readOnly ? "read" : "write",
              })}
            </dd>
          </dl>
          <ToolSchema tool={tool} />
        </div>
      )}
    </SheetDialog>
  );
}

function CategoriesDialog({
  open,
  onOpenChange,
  counts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  counts: readonly [string, number][];
}) {
  const t = useTranslations("agents.detail.toolbelt.rules.categories");
  const locale = useLocale();
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      wide
      testId="belt-categories-dialog"
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted-foreground">{t("body")}</p>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {counts.map(([category, count]) => (
            <li key={category} className="flex justify-between gap-3 px-3 py-2">
              <span className={mono}>
                {category === NO_CATEGORY ? t("none") : category}
              </span>
              <span className="text-dim">{formatCount(count, locale)}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">{t("axes")}</p>
      </div>
    </SheetDialog>
  );
}

export function DecisionRules({ belt }: { belt: Toolbelt }) {
  const t = useTranslations("agents.detail.toolbelt.rules");
  const locale = useLocale();
  const [layout, setLayout] = useState<"group" | "flat">("group");
  const [category, setCategory] = useState<string | null>(null);
  const [open, setOpen] = useState<BeltTool | null>(null);
  const [legend, setLegend] = useState(false);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const tool of belt.tools) {
      const key = tool.category ?? NO_CATEGORY;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [belt.tools]);
  const shown =
    category === null
      ? belt.tools
      : belt.tools.filter(
          (tool) => (tool.category ?? NO_CATEGORY) === category,
        );
  const high = belt.tools.filter((tool) => tool.riskLevel === "high").length;
  const approval = belt.tools.filter(
    (tool) => tool.decision === "require_approval",
  ).length;
  const columns = [
    "tool",
    "category",
    "decision",
    "hazard",
    "egress",
    "financial",
    "digest",
  ] as const;

  function row(tool: BeltTool) {
    return (
      <tr key={tool.name} data-testid="belt-tool" data-risk={tool.riskLevel}>
        <td className={cell}>
          <button
            type="button"
            className={`${linkText} ${mono} break-all text-left`}
            onClick={() => {
              setOpen(tool);
            }}
          >
            {tool.name}
          </button>
          {tool.server === null ? null : (
            <span className={`${mono} block text-xs text-muted-foreground`}>
              {tool.server}
            </span>
          )}
        </td>
        <td className={cell}>
          {tool.category === null ? (
            <NotRecordedValue />
          ) : (
            <Badge tone="quiet" dot={false} mono>
              {tool.category}
            </Badge>
          )}
        </td>
        <td className={cell} data-decision={tool.decision}>
          <Badge tone={tool.decision === "allow" ? "allowed" : "approval"}>
            {t(`decision.${tool.decision}`)}
          </Badge>
          <span className={`${mono} block text-xs text-muted-foreground`}>
            {tool.rule}
          </span>
        </td>
        <td className={cell}>
          {t("hazard", {
            risk: tool.riskLevel,
            access: tool.readOnly ? "read" : "write",
          })}
        </td>
        <td className={cell}>
          <NotRecordedValue />
        </td>
        <td className={cell}>
          <NotRecordedValue />
        </td>
        <td className={`${cell} ${mono} text-xs text-dim`}>
          {tool.schemaDigest === null ? (
            <NotRecordedValue />
          ) : (
            `sha256:${tool.schemaDigest.slice(0, 8)}…`
          )}
        </td>
      </tr>
    );
  }

  const grouped =
    layout === "flat"
      ? shown.map(row)
      : counts
          .filter(([key]) =>
            shown.some((tool) => (tool.category ?? NO_CATEGORY) === key),
          )
          .flatMap(([key]) => {
            const rows = shown.filter(
              (tool) => (tool.category ?? NO_CATEGORY) === key,
            );
            return [
              <tr
                key={`group-${key}`}
                data-testid="belt-group"
                className="bg-hl"
              >
                <td className={`${cell} font-semibold`} colSpan={6}>
                  {key === NO_CATEGORY ? t("categories.none") : key}
                </td>
                <td className={`${cell} text-xs text-dim`}>
                  {t("groupCount", { count: rows.length })}
                </td>
              </tr>,
              ...rows.map(row),
            ];
          });

  return (
    <Panel
      id="belt-rules"
      title={t("title")}
      lead={t("lead")}
      aside={
        <>
          <Segmented
            label={t("layout")}
            value={layout}
            options={[
              { value: "group", label: t("byCategory") },
              { value: "flat", label: t("flat") },
            ]}
            onChange={setLayout}
          />
          <Badge tone="quiet" dot={false}>
            {t("shown", {
              shown: formatCount(shown.length, locale),
              total: formatCount(belt.tools.length, locale),
            })}
          </Badge>
        </>
      }
    >
      {belt.tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div
            role="group"
            aria-label={t("chips")}
            className="flex flex-wrap gap-1.5"
          >
            <button
              type="button"
              aria-pressed={category === null}
              className={`${buttonSecondary} ${pressed}`}
              onClick={() => {
                setCategory(null);
              }}
            >
              {t("all", { count: belt.tools.length })}
            </button>
            {counts.map(([key, count]) => (
              <button
                key={key}
                type="button"
                aria-pressed={category === key}
                className={`${buttonSecondary} ${pressed}`}
                onClick={() => {
                  setCategory(key);
                }}
              >
                {key === NO_CATEGORY ? t("categories.none") : key}{" "}
                <span className="text-dim">{formatCount(count, locale)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span data-testid="belt-high">{t("high", { count: high })}</span>
            <span data-testid="belt-approval">
              {t("approvalCount", { count: approval })}
            </span>
            <button
              type="button"
              className={`${buttonSecondary} ml-auto`}
              onClick={() => {
                setLegend(true);
              }}
            >
              {t("categories.open")}
            </button>
          </div>
          <div className="min-w-0 overflow-x-auto">
            <table
              aria-label={t("title")}
              className="w-full min-w-[720px] border-collapse text-[13px]"
            >
              <thead>
                <tr className="border-b border-border">
                  {columns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className={`${headCell} text-left`}
                    >
                      {t(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">{grouped}</tbody>
            </table>
          </div>
        </>
      )}
      <ToolDialog
        tool={open}
        onClose={() => {
          setOpen(null);
        }}
      />
      <CategoriesDialog
        open={legend}
        onOpenChange={setLegend}
        counts={counts}
      />
    </Panel>
  );
}
