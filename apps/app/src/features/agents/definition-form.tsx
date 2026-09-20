"use client";
// The Configuration tab (mockup agent.md "Definition in git — the TOML
// rendered as a form"; ADR-057 decision 1): every field is a view of
// `.oxagen/agents/<slug>.toml`. An edit patches one key of the draft in place
// (toml-patch.ts) and keeps every other byte, so a form edit diffs like a
// hand edit; Save opens the same commit sheet the source editor uses, which
// commits the draft to a branch and opens its pull request. The default
// branch is never written and nothing lands in Postgres but the commit's
// cache. The source editor is one link away for anything the form does not
// reach.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useMemo, useState } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import { isEffective, type MandateList } from "@/data/contracts/mandates";
import { diffStat } from "@/shared/line-diff";
import type { SafePath } from "@/shared/safe-path";
import {
  tomlLiteral,
  tomlMultiline,
  tomlSet,
  tomlTableForm,
} from "@/shared/toml-patch";
import {
  parseTomlSubset,
  type TomlParse,
  type TomlTable,
  type TomlValue,
  tomlGet,
} from "@/shared/toml-subset";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { Facts, Instant, Panel } from "./parts";
import { CommitDialog } from "./source-editor";

const MODEL_TIERS = ["complex", "light"] as const;
const COLORS = ["blue", "green", "gold", "red", "gray"] as const;
const SIDE_EFFECTS = ["read", "write", "irreversible"] as const;
type SideEffect = (typeof SIDE_EFFECTS)[number];

const text = (value: TomlValue | undefined): string =>
  typeof value === "string" ? value : "";

const strings = (value: TomlValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const table = (value: TomlValue | undefined): TomlTable | null =>
  typeof value === "object" && !Array.isArray(value) ? value : null;

/**
 * Micros as the plain decimal a number input takes, locale-free by the
 * input's contract: it is a control's value, not money shown to a person,
 * which <Money> formats (INV-09). It carries every micro the file stores
 * (`2.500001`, never `2.50`) so that focusing and leaving the field reads
 * back the integer it was drawn from. Rounded to cents, a blur re-parsed the
 * rounded display, marked the form dirty, and turned a sub-cent budget into
 * zero. Trailing zeros past the second decimal are dropped, so a whole
 * number of cents still reads as money.
 */
function usdInputValue(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/(?<=\d{2})0+$/, "");
  return `${String(whole)}.${fraction}`;
}

/** The dollars a person typed, as the integer micros the file stores; null when the text is not a non-negative number. */
function parseUsdMicros(text: string): number | null {
  const usd = Number.parseFloat(text);
  if (!Number.isFinite(usd) || usd < 0) return null;
  const micros = Math.round(usd * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * The draft with `budget.per_run_micros` set to `next` and every other budget
 * key kept. The file may spell the table three ways, and the patcher works on
 * lines, so the spelling decides which line is rewritten: a `[budget]` table
 * gets its own key line, a dotted root key is replaced on its line, and an
 * inline table (or no budget at all) is rewritten at the root with `siblings`
 * carried across, the per-run key kept in the place it held. Writing
 * `{ per_run_micros = next }` regardless replaced the whole table and
 * silently dropped `per_day_micros`, `mode` and anything else beside it.
 * The spelling is read by the patcher's own scan, which skips multi-line
 * bodies: a regex over the whole source once took a `[budget]` line inside
 * the instructions for a header and appended a second table.
 */
function setPerRunMicros(
  current: string,
  siblings: TomlTable | null,
  next: number,
): string {
  const literal = tomlLiteral(next);
  const form = tomlTableForm(current, "budget");
  if (form === "header")
    return tomlSet(current, "budget", "per_run_micros", literal);
  if (form === "dotted")
    return tomlSet(current, null, "budget.per_run_micros", literal);
  return tomlSet(
    current,
    null,
    "budget",
    tomlLiteral({ ...(siblings ?? {}), per_run_micros: next }),
  );
}

/** The draft's document: what parses, or the empty table with the line that stopped the parse. */
function readDraft(draft: string): {
  doc: TomlTable;
  error: Extract<TomlParse, { ok: false }> | null;
} {
  const parsed = parseTomlSubset(draft);
  return parsed.ok
    ? { doc: parsed.doc, error: null }
    : { doc: {}, error: parsed };
}

function Labelled({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** A list of patterns as removable chips with an input that adds one on Enter. */
function Chips({
  id,
  values,
  onChange,
  addLabel,
  placeholder,
  removeLabel,
}: {
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  placeholder: string;
  removeLabel: (value: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((value, i) => (
        <span
          key={value}
          className={`${mono} inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs`}
        >
          <span>{value}</span>
          <button
            type="button"
            aria-label={removeLabel(value)}
            className="rounded-sm px-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              onChange(values.filter((_, j) => j !== i));
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={addLabel}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`${inputBase} ${mono} min-h-9 w-auto min-w-48 flex-1 py-1.5`}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const value = event.currentTarget.value.trim();
          if (value.length === 0) return;
          event.preventDefault();
          if (!values.includes(value)) onChange([...values, value]);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}

export function DefinitionForm({
  org,
  ws,
  identity,
  definition,
  path,
  base,
  branch,
  mandates,
  editor,
  after,
}: {
  org: string;
  ws: string;
  identity: AgentDetail["identity"];
  definition: AgentDetail["definition"];
  /** `.oxagen/agents/<slug>.toml`. */
  path: string;
  /** The committed file, or the seed an agent with no committed file starts from. */
  base: string;
  /** The branch the commit sheet proposes. */
  branch: string;
  /** The agent's mandates and the instant they were read at; null when the ledger could not say. */
  mandates: MandateList | null;
  /** The source editor for this file. */
  editor: SafePath;
  /** This tab, reloaded after a commit so the base is the committed file. */
  after: SafePath;
}) {
  const t = useTranslations("agents.detail.definition");
  const ts = useTranslations("agents.source");
  const id = useId();
  const [draft, setDraft] = useState(base);
  const [committing, setCommitting] = useState(false);
  const { doc, error } = useMemo(() => readDraft(draft), [draft]);
  const stat = useMemo(() => diffStat(base, draft), [base, draft]);
  const dirty = draft !== base;
  // Irreversible effects need a mandate that authorizes something now, and
  // only an active row inside its window does: a draft is a request nobody
  // has granted, and revoked and expired rows are history. Counting rows
  // unlocked the checkbox the moment an operator asked for a mandate, which
  // is when they hold none. Judged at the ledger's own instant so the answer
  // is the page's, not whenever this component happens to render.
  const activeMandates = useMemo(
    () =>
      mandates === null
        ? null
        : mandates.mandates.filter((mandate) =>
            isEffective(mandate, new Date(mandates.asOf)),
          ).length,
    [mandates],
  );

  const set = (section: string | null, key: string, value: TomlValue) => {
    setDraft((current) => tomlSet(current, section, key, tomlLiteral(value)));
  };
  const field = (key: string) => `${id}-${key}`;

  const budget = table(tomlGet(doc, "budget"));
  const micros =
    budget === null ? undefined : tomlGet(budget, "per_run_micros");
  const perRunMicros =
    typeof micros === "number" && Number.isSafeInteger(micros) && micros >= 0
      ? micros
      : null;
  const perRunUsd = perRunMicros === null ? "" : usdInputValue(perRunMicros);
  const tier = text(tomlGet(doc, "model_tier"));
  const tiers: readonly string[] =
    tier === "" || MODEL_TIERS.some((known) => known === tier)
      ? MODEL_TIERS
      : [...MODEL_TIERS, tier];
  const effects = strings(tomlGet(doc, "side_effects"));
  const harnessSection = `harness.${identity.harness}`;
  const harnessTable = table(tomlGet(doc, "harness"));
  const harness =
    harnessTable === null
      ? null
      : table(tomlGet(harnessTable, identity.harness));
  const color = harness === null ? "" : text(tomlGet(harness, "color"));
  const colors: readonly string[] =
    color === "" || COLORS.some((known) => known === color)
      ? COLORS
      : [...COLORS, color];
  const instructions = table(tomlGet(doc, "instructions"));
  const body = instructions === null ? "" : text(tomlGet(instructions, "body"));

  function setEffect(effect: SideEffect, on: boolean) {
    const next = SIDE_EFFECTS.filter((e) =>
      e === effect ? on : effects.includes(e),
    );
    set(null, "side_effects", [...next]);
  }

  const bar =
    error !== null ? (
      <FormAlert testId="definition-unparsed">
        <span className="flex flex-wrap items-center gap-3">
          <span>
            {t("unparsed", {
              line: error.line,
              reason: ts(`parse.reason.${error.code}`),
            })}
          </span>
          <span className="flex flex-wrap gap-2">
            <SafeLink to={editor} className={buttonSecondary}>
              {t("openEditor")}
            </SafeLink>
            <button
              type="button"
              className={buttonSecondary}
              disabled={!dirty}
              onClick={() => {
                setDraft(base);
              }}
            >
              {t("bar.discard")}
            </button>
          </span>
        </span>
      </FormAlert>
    ) : dirty ? (
      <div
        role="status"
        data-testid="definition-dirty"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-banner px-4 py-3 text-sm"
      >
        <b>{t("bar.dirty")}</b>
        <span className={`${mono} text-xs`}>{ts("stat", stat)}</span>
        <span className="text-muted-foreground">
          {definition === null
            ? t("bar.againstSeed")
            : t("bar.against", {
                branch: definition.branch,
                commit: definition.commitSha,
              })}
        </span>
        <span className="flex flex-1 flex-wrap justify-end gap-2">
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              setDraft(base);
            }}
          >
            {t("bar.discard")}
          </button>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              setCommitting(true);
            }}
          >
            {t("bar.save")}
          </button>
        </span>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {bar}
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        {/* A file the subset cannot read is not patched by the form; the source editor is where it is fixed. */}
        <fieldset
          disabled={error !== null}
          className="flex min-w-0 flex-col gap-4"
        >
          <Panel
            id="definition-identity"
            title={t("identity.title")}
            lead={t("identity.aside")}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Labelled id={field("schema")} label={t("identity.schema")}>
                <input
                  id={field("schema")}
                  readOnly
                  value={text(tomlGet(doc, "schema"))}
                  className={`${inputBase} ${mono}`}
                />
              </Labelled>
              <Labelled
                id={field("slug")}
                label={t("identity.slug")}
                hint={t("identity.slugHint", {
                  key: identity.agentKey ?? identity.slug,
                })}
              >
                <input
                  id={field("slug")}
                  readOnly
                  value={text(tomlGet(doc, "slug"))}
                  className={`${inputBase} ${mono}`}
                />
              </Labelled>
            </div>
            <Labelled id={field("name")} label={t("identity.name")}>
              <input
                id={field("name")}
                defaultValue={text(tomlGet(doc, "name"))}
                key={`name:${text(tomlGet(doc, "name"))}`}
                className={inputBase}
                onBlur={(event) => {
                  if (event.target.value !== text(tomlGet(doc, "name")))
                    set(null, "name", event.target.value);
                }}
              />
            </Labelled>
            <Labelled
              id={field("description")}
              label={t("identity.description")}
              hint={t("identity.descriptionHint")}
            >
              <input
                id={field("description")}
                defaultValue={text(tomlGet(doc, "description"))}
                key={`description:${text(tomlGet(doc, "description"))}`}
                className={inputBase}
                onBlur={(event) => {
                  if (event.target.value !== text(tomlGet(doc, "description")))
                    set(null, "description", event.target.value);
                }}
              />
            </Labelled>
          </Panel>

          <Panel id="definition-model" title={t("model.title")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labelled
                id={field("tier")}
                label={t("model.tier")}
                hint={t("model.tierHint")}
              >
                <select
                  id={field("tier")}
                  value={tier}
                  className={inputBase}
                  onChange={(event) => {
                    set(null, "model_tier", event.target.value);
                  }}
                >
                  {tier === "" ? <option value="">{t("unset")}</option> : null}
                  {tiers.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Labelled>
              <Labelled
                id={field("budget")}
                label={t("model.budget")}
                hint={t("model.budgetHint", {
                  micros: perRunMicros === null ? "…" : String(perRunMicros),
                })}
              >
                {/* Any decimal: the stored value is a micro, and a step of a cent would flag the field invalid for the value the file itself holds. */}
                <input
                  id={field("budget")}
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  key={`budget:${perRunUsd}`}
                  defaultValue={perRunUsd}
                  className={`${inputBase} ${mono}`}
                  onBlur={(event) => {
                    // Untouched text is not an edit, whatever it parses to.
                    if (event.target.value === perRunUsd) return;
                    const next = parseUsdMicros(event.target.value);
                    if (next === null || next === perRunMicros) return;
                    setDraft((current) =>
                      setPerRunMicros(current, budget, next),
                    );
                  }}
                />
              </Labelled>
            </div>
          </Panel>

          <Panel
            id="definition-tools"
            title={t("tools.title")}
            lead={t("tools.aside")}
          >
            <Labelled
              id={field("tools")}
              label={t("tools.tools")}
              hint={t("tools.toolsHint")}
            >
              <Chips
                id={field("tools")}
                values={strings(tomlGet(doc, "tools"))}
                onChange={(next) => {
                  set(null, "tools", next);
                }}
                addLabel={t("tools.add", { key: "tools" })}
                placeholder={t("tools.addPlaceholder")}
                removeLabel={(value) => t("tools.remove", { value })}
              />
            </Labelled>
            <Labelled
              id={field("deny")}
              label={t("tools.denyTools")}
              hint={t("tools.denyHint")}
            >
              <Chips
                id={field("deny")}
                values={strings(tomlGet(doc, "deny_tools"))}
                onChange={(next) => {
                  set(null, "deny_tools", next);
                }}
                addLabel={t("tools.add", { key: "deny_tools" })}
                placeholder={t("tools.addPlaceholder")}
                removeLabel={(value) => t("tools.remove", { value })}
              />
            </Labelled>
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-foreground">
                {t("tools.sideEffects")}
              </legend>
              {SIDE_EFFECTS.map((effect) => {
                // Adding `irreversible` needs proof of an active mandate, so a
                // ledger that did not answer locks it the same as one that
                // answered none. Removing it needs no authority at all: a
                // file that already carries the effect must stay editable
                // when the mandate behind it has lapsed.
                const locked =
                  effect === "irreversible" &&
                  !effects.includes(effect) &&
                  (activeMandates === null || activeMandates === 0);
                return (
                  <label
                    key={effect}
                    className={`flex items-start gap-2 text-sm ${locked ? "text-muted-foreground" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={effects.includes(effect)}
                      disabled={locked}
                      onChange={(event) => {
                        setEffect(effect, event.target.checked);
                      }}
                    />
                    <span className="flex flex-col">
                      <span className={mono}>{effect}</span>
                      <span className="text-xs text-muted-foreground">
                        {effect !== "irreversible"
                          ? t(`tools.${effect}`)
                          : activeMandates === null
                            ? t("tools.irreversibleUnknown")
                            : t("tools.irreversible", {
                                count: activeMandates,
                              })}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </Panel>

          <Panel
            id="definition-instructions"
            title={t("instructions.title")}
            lead={t("instructions.aside")}
          >
            <Labelled
              id={field("body")}
              label={t("instructions.label")}
              hint={t("instructions.hint")}
            >
              <textarea
                id={field("body")}
                rows={6}
                key={`body:${body}`}
                defaultValue={body}
                spellCheck={false}
                className={`${inputBase} ${mono} bg-code-bg`}
                onBlur={(event) => {
                  const next = event.target.value.replace(/\r/g, "");
                  if (next !== body)
                    setDraft((current) =>
                      tomlSet(
                        current,
                        "instructions",
                        "body",
                        tomlMultiline(next),
                      ),
                    );
                }}
              />
            </Labelled>
          </Panel>

          <Panel
            id="definition-harness"
            title={t("harness.title")}
            lead={`[${harnessSection}]`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Labelled
                id={field("harness")}
                label={t("harness.harness")}
                hint={t("harness.harnessHint")}
              >
                <input
                  id={field("harness")}
                  readOnly
                  value={identity.harness}
                  className={`${inputBase} ${mono}`}
                />
              </Labelled>
              <Labelled
                id={field("color")}
                label={t("harness.color")}
                hint={t("harness.colorHint")}
              >
                <select
                  id={field("color")}
                  value={color}
                  className={inputBase}
                  onChange={(event) => {
                    set(harnessSection, "color", event.target.value);
                  }}
                >
                  {color === "" ? <option value="">{t("unset")}</option> : null}
                  {colors.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Labelled>
            </div>
          </Panel>
        </fieldset>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            id="definition-source"
            title={t("source.title")}
            lead={t("source.truth")}
          >
            <SafeLink
              to={editor}
              className={`${buttonSecondary} justify-between gap-3 text-left`}
            >
              <span className={`${mono} min-w-0 break-all`}>{path}</span>
              <span className="text-xs text-muted-foreground">
                {t("source.open")}
              </span>
            </SafeLink>
            <p className="text-xs text-muted-foreground">{t("source.lead")}</p>
            {definition === null ? (
              <p className="text-sm text-muted-foreground">
                {t("source.uncommitted")}
              </p>
            ) : (
              <Facts
                rows={[
                  {
                    term: t("source.branch"),
                    value: <span className={mono}>{definition.branch}</span>,
                  },
                  {
                    term: t("source.commit"),
                    value: (
                      <span className={mono}>
                        {definition.commitSha}
                        {dirty ? (
                          <span className="text-info">
                            {" "}
                            · {t("source.draft")}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    term: t("source.digest"),
                    value: (
                      <span className={`${mono} break-all`}>
                        {definition.digest}
                      </span>
                    ),
                  },
                  {
                    term: t("source.pullRequest"),
                    value: (
                      <span className={`${mono} break-all`}>
                        {definition.pullRequestUrl}
                      </span>
                    ),
                  },
                  {
                    term: t("source.committed"),
                    value: <Instant at={definition.committedAt} />,
                  },
                ]}
              />
            )}
          </Panel>
          <Panel id="definition-changing" title={t("changing.title")}>
            <ol className="flex flex-col gap-2 text-sm">
              {(["edit", "checks", "review", "merge"] as const).map((step) => (
                <li key={step} className="flex flex-col">
                  <span className="font-medium">
                    {t(`changing.${step}.title`)}
                  </span>
                  <span className="text-muted-foreground">
                    {t(`changing.${step}.body`)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t("changing.note")}
            </p>
          </Panel>
        </div>
      </div>
      <CommitDialog
        open={committing}
        onOpenChange={setCommitting}
        org={org}
        ws={ws}
        agentId={identity.id}
        path={path}
        branch={branch}
        draft={draft}
        stat={stat}
        after={after}
      />
    </div>
  );
}
