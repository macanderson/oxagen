"use client";
// A Studio server's Tools tab (#4678): every tool the server offers, imported
// or available, with its risk, side effect and the tokens its definition adds
// to every model call, and a running total against the server's
// `definition_budget`.
//
// Importing, removing, classifying and describing are staged in the draft;
// the Changes tab shows the diff and opens the steering PR. A classification
// Studio suggested reads as a suggestion until a person confirms it. The
// per-tool off switches are drawn on the server (switch-controls.tsx) and
// arrive here as nodes, mounted only for the rows the page shows.
//
// Above the table, the tab follows the server's discovery (#4678, item 8)
// and, once list_studio_tools answers, says how many tools tools.toml imports
// of those the last discovery listed, whether the definitions would fit
// better behind tool search, and whether tools.toml compiled. Both reads are
// lane M10's (#4682). When a read fails, the tab says so in its place.
//
// Two of spend detector 2's levers sit beside that hint. Tool exposure stages
// server.toml's exposure mode: Full sends every imported definition on every
// request, and Searchable sends the server's three search tools. Calls counts
// the imported tools agents called over the record's feedback window, from
// each key's call count, and names the ones no agent called, so the person
// can see what a provider costs against what agents use.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import type { ToolRiskGrade, ToolSideEffect } from "@/data/contracts/tools";
import { Badge, type BadgeTone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import {
  ListBar,
  type ListFilter,
  ListPager,
  useList,
} from "@/ui/list-controls";
import { FormAlert } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { StateWrap } from "@/ui/state-wrap";
import { cell, headCell, numericCell } from "@/ui/table";
import {
  type DraftOp,
  draftExposure,
  draftTokens,
  type ExposureMode,
  importedAfter,
  stagedClassification,
  stagedExposure,
} from "./draft";
import type { StudioRecord, StudioTool } from "./model";
import { StudioNotRecorded, StudioNotRecordedValue } from "./not-recorded";
import { DiscoveryProgress } from "./add-server";
import type { StudioAt } from "./route";
import type {
  DraftStudioDescription,
  StudioToolsList,
} from "./studio-calls";
import { toolCalls } from "./tool-calls";
import { ToolPanel } from "./tool-panel";
import { useStudioDraft } from "./use-draft";

const RISK_TONE: Readonly<Record<ToolRiskGrade, BadgeTone>> = {
  low: "quiet",
  medium: "quiet",
  high: "denied",
  critical: "critical",
};

type RowState = "imported" | "available" | "stagedImport" | "stagedRemove";

function rowState(tool: StudioTool, ops: readonly DraftOp[]): RowState {
  const after = importedAfter(tool, ops);
  if (tool.imported) return after ? "imported" : "stagedRemove";
  return after ? "stagedImport" : "available";
}

const STATE_TONE: Readonly<Record<RowState, BadgeTone>> = {
  imported: "allowed",
  available: "quiet",
  stagedImport: "approval",
  stagedRemove: "approval",
};

/** The classification a row shows: the draft's, else the record's. */
function shownClassification(
  tool: StudioTool,
  ops: readonly DraftOp[],
): { risk: ToolRiskGrade; sideEffect: ToolSideEffect; suggested: boolean } | null {
  const staged = stagedClassification(tool.name, ops);
  if (staged !== undefined) {
    return { risk: staged.risk, sideEffect: staged.sideEffect, suggested: false };
  }
  const current = tool.classification;
  if (current === null) return null;
  return {
    risk: current.risk,
    sideEffect: current.sideEffect,
    suggested: !current.confirmed,
  };
}

function Budget({
  record,
  tools,
  ops,
}: {
  record: StudioRecord | null;
  tools: readonly StudioTool[];
  ops: readonly DraftOp[];
}) {
  const t = useTranslations("mcpStudio.tools.budget");
  const locale = useLocale();
  if (record === null) {
    return (
      <StudioNotRecorded gap="record" testId="studio-budget-missing">
        {t("missing")}
      </StudioNotRecorded>
    );
  }
  const budget = record.exposure.definitionBudget;
  const { before, after } = draftTokens({ tools }, ops);
  const over = after !== null && after > budget;
  return (
    <section
      aria-labelledby="studio-budget-h"
      className={panel}
      data-testid="studio-budget"
    >
      <div className={panelHeader}>
        <h2 id="studio-budget-h" className={panelTitle}>
          {t("title")}
        </h2>
        {over ? (
          <Badge tone="denied" data-testid="studio-budget-over">
            {t("over")}
          </Badge>
        ) : null}
      </div>
      <div className={`${panelBody} flex flex-col gap-2`}>
        {after === null ? (
          <p className="text-sm text-muted-foreground">
            {t("unmeasured", { budget: formatCount(budget, locale) })}
          </p>
        ) : (
          <>
            <p
              className="text-sm text-foreground"
              data-testid="studio-budget-used"
            >
              {t("used", {
                used: formatCount(after, locale),
                budget: formatCount(budget, locale),
              })}
            </p>
            <div
              role="img"
              aria-label={t("meter", {
                used: formatCount(after, locale),
                budget: formatCount(budget, locale),
              })}
              data-over={over ? "true" : undefined}
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <i
                className={`block h-full shrink-0 ${over ? "bg-warning" : "bg-foreground"}`}
                style={{
                  width: `${String(budget === 0 ? 100 : Math.min(100, (after / budget) * 100))}%`,
                }}
              />
            </div>
          </>
        )}
        {before !== null && after !== null && before !== after ? (
          <p className="text-sm text-muted-foreground">
            {t("before", { before: formatCount(before, locale) })}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What list_studio_tools counted. A compile error's text is the handler's,
 * so the tab names the failure in its own words and never shows the text.
 */
function Listed({ listed }: { listed: StudioToolsList }) {
  const t = useTranslations("mcpStudio.tools.listed");
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-2" data-testid="studio-tools-listed">
      <p className="text-sm text-foreground">
        {t("counts", {
          imported: formatCount(listed.imported, locale),
          offered: formatCount(listed.offered, locale),
        })}
      </p>
      {listed.searchRecommended ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="studio-tools-search"
        >
          {t("search")}
        </p>
      ) : null}
      {listed.compileError === null ? null : (
        <FormAlert testId="studio-tools-compile-error">
          {t("compileError")}
        </FormAlert>
      )}
    </div>
  );
}

const MODES: readonly ExposureMode[] = ["direct", "search"];

/**
 * server.toml's exposure mode, staged in the draft. Choosing the mode
 * server.toml already sets drops a staged change rather than staging a
 * second one.
 */
function Exposure({
  record,
  ops,
  canEdit,
  onStage,
  onUnstage,
}: {
  record: StudioRecord;
  ops: readonly DraftOp[];
  canEdit: boolean;
  onStage: (op: DraftOp) => void;
  onUnstage: (index: number) => void;
}) {
  const t = useTranslations("mcpStudio.tools.exposure");
  const id = useId();
  const current = record.exposure.mode;
  const shown = stagedExposure(ops) ?? current;
  const changed = draftExposure({ tools: [], exposure: current }, ops) !== null;
  const choose = (mode: ExposureMode) => {
    if (mode === shown) return;
    if (mode === current) {
      const at = ops.findIndex((op) => op.kind === "expose");
      if (at !== -1) onUnstage(at);
      return;
    }
    onStage({ kind: "expose", mode });
  };
  return (
    <section
      aria-labelledby={`${id}-h`}
      className={panel}
      data-testid="studio-exposure"
    >
      <div className={panelHeader}>
        <h2 id={`${id}-h`} className={panelTitle}>
          {t("title")}
        </h2>
        {changed ? (
          <Badge tone="approval" data-testid="studio-exposure-staged">
            {t("staged")}
          </Badge>
        ) : null}
      </div>
      <div className={`${panelBody} flex flex-col gap-2`}>
        {canEdit ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("title")}</legend>
            {MODES.map((mode) => (
              <div key={mode} className="flex items-start gap-2 text-sm">
                <input
                  id={`${id}-${mode}`}
                  type="radio"
                  name={`${id}-mode`}
                  value={mode}
                  checked={shown === mode}
                  aria-describedby={`${id}-${mode}-body`}
                  onChange={() => {
                    choose(mode);
                  }}
                  className="mt-0.5 size-4 accent-gold"
                  data-testid={`studio-exposure-${mode}`}
                />
                <div className="flex flex-col">
                  <label
                    htmlFor={`${id}-${mode}`}
                    className="font-medium text-foreground"
                  >
                    {t(`modes.${mode}`)}
                  </label>
                  <span
                    id={`${id}-${mode}-body`}
                    className="text-sm text-muted-foreground"
                  >
                    {t(`bodies.${mode}`)}
                  </span>
                </div>
              </div>
            ))}
          </fieldset>
        ) : (
          <p
            className="flex flex-col text-sm text-foreground"
            data-testid="studio-exposure-mode"
          >
            <span className="font-medium">{t(`modes.${shown}`)}</span>
            <span className="text-sm text-muted-foreground">
              {t(`bodies.${shown}`)}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

/** The imported tools agents called over the feedback window, and the ones they did not. */
function Calls({
  record,
  tools,
}: {
  record: StudioRecord;
  tools: readonly StudioTool[];
}) {
  const t = useTranslations("mcpStudio.tools.calls");
  const locale = useLocale();
  const id = useId();
  const calls = toolCalls(record, tools);
  if (calls.kind === "none") return null;
  return (
    <section
      aria-labelledby={`${id}-h`}
      className={panel}
      data-testid="studio-calls"
    >
      <div className={panelHeader}>
        <h2 id={`${id}-h`} className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={`${panelBody} flex flex-col gap-2`}>
        {calls.kind === "notRecorded" ? (
          <StudioNotRecorded gap="record" testId="studio-calls-missing">
            {t("missing")}
          </StudioNotRecorded>
        ) : (
          <>
            <p
              className="text-sm text-foreground"
              data-testid="studio-calls-counts"
            >
              {t("counts", {
                called: formatCount(calls.called, locale),
                counted: formatCount(calls.counted, locale),
                days: calls.windowDays,
              })}
            </p>
            {calls.unrecorded === 0 ? null : (
              <p
                className="text-sm text-muted-foreground"
                data-testid="studio-calls-unrecorded"
              >
                {t("unrecorded", { count: calls.unrecorded })}
              </p>
            )}
            {calls.uncalled.length === 0 ? null : (
              <>
                <h3
                  id={`${id}-uncalled`}
                  className="text-sm font-semibold text-foreground"
                >
                  {t("uncalled")}
                </h3>
                <ul
                  aria-labelledby={`${id}-uncalled`}
                  className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-sm text-foreground"
                  data-testid="studio-calls-uncalled"
                >
                  {calls.uncalled.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function ToolsTab({
  at,
  serverName,
  serverId,
  record,
  tools,
  canEdit,
  off,
  offFacts,
  draft,
  listed = null,
}: {
  /** The workspace the draft belongs to. */
  at: StudioAt;
  /** The folder name the draft is keyed by; null until the record names it. */
  serverName: string | null;
  serverId: string;
  record: StudioRecord | null;
  tools: readonly StudioTool[];
  /** An org or workspace Owner or Admin: who edits and turns tools off. */
  canEdit: boolean;
  /** Each imported tool's off switch toggle, by tool name, drawn on the server. */
  off: Readonly<Record<string, ReactNode>>;
  /** Who turned each tool off or back on, and when, by tool name. */
  offFacts: Readonly<Record<string, ReactNode>>;
  /** Draft's capability for the tool panel. A test passes a fake. */
  draft?: DraftStudioDescription;
  /** list_studio_tools' answer, or null while it loads or when it fails. */
  listed?: StudioToolsList | null;
}) {
  const t = useTranslations("mcpStudio.tools");
  const registry = useTranslations("tools.registry");
  const locale = useLocale();
  const studioDraft = useStudioDraft({ at, serverName, serverId });
  const { ops } = studioDraft;
  const [openTool, setOpenTool] = useState<string | null>(null);
  /** The draft refused the last edit, because it would pass the draft's limits. */
  const [refused, setRefused] = useState(false);
  const stage = (op: DraftOp): boolean => {
    const ok = studioDraft.stage(op);
    setRefused(!ok);
    return ok;
  };
  /**
   * The panel shows its own refusal, so an edit from the panel clears the
   * tab's alert instead of raising it. One refusal is announced once.
   */
  const stageFromPanel = (op: DraftOp): boolean => {
    setRefused(false);
    return studioDraft.stage(op);
  };
  const filters: readonly ListFilter<StudioTool>[] = [
    {
      key: "state",
      label: t("filters.state"),
      options: [
        { value: "imported", label: t("states.imported") },
        { value: "available", label: t("states.available") },
      ],
      get: (tool) => (importedAfter(tool, ops) ? "imported" : "available"),
    },
    {
      key: "risk",
      label: t("filters.risk"),
      options: [
        ...(["low", "medium", "high", "critical"] as const).map((value) => ({
          value,
          label: registry(`risk.${value}`),
        })),
        { value: "unclassified", label: t("unclassified") },
      ],
      get: (tool) => shownClassification(tool, ops)?.risk ?? "unclassified",
    },
    {
      key: "sideEffect",
      label: t("filters.sideEffect"),
      options: [
        ...(["read", "write", "irreversible"] as const).map((value) => ({
          value,
          label: registry(`sideEffect.${value}`),
        })),
        { value: "unclassified", label: t("unclassified") },
      ],
      get: (tool) =>
        shownClassification(tool, ops)?.sideEffect ?? "unclassified",
    },
  ];
  const list = useList(tools, {
    text: (tool) => `${tool.name} ${tool.description ?? ""}`,
    filters,
  });
  const opened =
    openTool === null
      ? undefined
      : tools.find((tool) => tool.name === openTool);
  const columns = canEdit ? 7 : 6;
  return (
    <div className="flex flex-col gap-4">
      <Budget record={record} tools={tools} ops={ops} />
      <DiscoveryProgress at={at} server={serverName} canStart={canEdit} />
      {listed === null ? null : <Listed listed={listed} />}
      {record === null ? null : (
        <>
          <Exposure
            record={record}
            ops={ops}
            canEdit={canEdit}
            onStage={stage}
            onUnstage={(index) => {
              setRefused(false);
              studioDraft.unstage(index);
            }}
          />
          <Calls record={record} tools={tools} />
        </>
      )}
      {record === null ? (
        <StudioNotRecorded gap="record" testId="studio-tools-missing">
          {t("missing")}
        </StudioNotRecorded>
      ) : null}
      {canEdit ? null : (
        <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
      )}
      {refused ? (
        <FormAlert testId="studio-tools-refused">{t("refused")}</FormAlert>
      ) : null}
      {tools.length === 0 ? (
        record === null ? null : (
          <StateWrap tone="neutral" testId="studio-tools-empty" title={t("empty.title")}>
            {t("empty.body")}
          </StateWrap>
        )
      ) : (
        <section
          aria-labelledby="studio-tools-h"
          className={panel}
          data-testid="studio-tools"
        >
          <div className={panelHeader}>
            <h2 id="studio-tools-h" className={panelTitle}>
              {t("title")}
            </h2>
          </div>
          <ListBar
            list={list}
            searchLabel={t("search")}
            filters={filters}
          />
          <div className="min-w-0 overflow-x-auto">
            <table
              aria-labelledby="studio-tools-h"
              className="w-full min-w-180 border-collapse text-sm"
            >
              <thead>
                <tr className="border-b border-border">
                  {canEdit ? (
                    <th scope="col" className={`${headCell} w-10 text-left`}>
                      {t("columns.import")}
                    </th>
                  ) : null}
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("columns.tool")}
                  </th>
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("columns.state")}
                  </th>
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("columns.risk")}
                  </th>
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("columns.sideEffect")}
                  </th>
                  <th scope="col" className={`${headCell} text-right`}>
                    {t("columns.tokens")}
                  </th>
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("columns.off")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.shown.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns}
                      className={`${cell} text-dim`}
                      data-testid="studio-tools-no-match"
                    >
                      {t("noMatch")}
                    </td>
                  </tr>
                ) : (
                  list.shown.map((tool) => {
                    const state = rowState(tool, ops);
                    const shown = shownClassification(tool, ops);
                    const after = importedAfter(tool, ops);
                    return (
                      <tr
                        key={tool.name}
                        data-testid={`studio-tool-${tool.name}`}
                        data-state={state}
                      >
                        {canEdit ? (
                          <td className={cell}>
                            <input
                              type="checkbox"
                              checked={after}
                              aria-label={t("importNamed", { tool: tool.name })}
                              data-testid={`studio-import-${tool.name}`}
                              onChange={() => {
                                stage({
                                  kind: after ? "remove" : "import",
                                  tool: tool.name,
                                });
                              }}
                              className="size-4 accent-gold"
                            />
                          </td>
                        ) : null}
                        <td className={cell}>
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            className="h-auto p-0 text-left font-mono"
                            onClick={() => {
                              setOpenTool(tool.name);
                            }}
                          >
                            {tool.name}
                          </Button>
                        </td>
                        <td className={cell}>
                          <Badge tone={STATE_TONE[state]}>
                            {t(`states.${state}`)}
                          </Badge>
                        </td>
                        <td className={cell}>
                          {shown === null ? (
                            <span className="text-muted-foreground">
                              {t("unclassified")}
                            </span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge tone={RISK_TONE[shown.risk]}>
                                {registry(`risk.${shown.risk}`)}
                              </Badge>
                              {shown.suggested ? (
                                <Badge
                                  tone="quiet"
                                  dot={false}
                                  data-testid={`studio-suggested-${tool.name}`}
                                >
                                  {t("suggested")}
                                </Badge>
                              ) : null}
                            </span>
                          )}
                        </td>
                        <td className={cell}>
                          {shown === null ? (
                            <span className="text-muted-foreground">
                              {t("unclassified")}
                            </span>
                          ) : (
                            registry(`sideEffect.${shown.sideEffect}`)
                          )}
                        </td>
                        <td className={numericCell}>
                          {tool.tokens === null ? (
                            <StudioNotRecordedValue gap="record" />
                          ) : (
                            formatCount(tool.tokens, locale)
                          )}
                        </td>
                        <td className={cell}>
                          {off[tool.name] ??
                            (tool.killSwitch?.on === true ? (
                              <Badge tone="denied">{t("offBadge")}</Badge>
                            ) : (
                              <span className="text-dim">{"—"}</span>
                            ))}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <ListPager
            list={list}
            label={t("pager")}
            rowsLabel={t("rows")}
            range={(from, to, total) => t("range", { from, to, total })}
            previousLabel={t("previous")}
            nextLabel={t("next")}
          />
        </section>
      )}
      {opened === undefined ? null : (
        <ToolPanel
          key={opened.name}
          at={at}
          serverName={serverName}
          tool={opened}
          ops={ops}
          canEdit={canEdit}
          onStage={stageFromPanel}
          off={off[opened.name] ?? null}
          offFacts={offFacts[opened.name] ?? null}
          open
          onOpenChange={(next) => {
            if (!next) setOpenTool(null);
          }}
          pageable={
            record?.source.type === "openapi" ||
            record?.source.type === "graphql"
          }
          {...(draft === undefined ? {} : { draft })}
        />
      )}
    </div>
  );
}
