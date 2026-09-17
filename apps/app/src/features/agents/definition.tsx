// The Definition in git section (ADR-057 decision 1): the file
// `.oxagen/agents/<slug>.toml` is the definition of record. This section reads
// the commit the last commit_agent_definition cached and renders the file's
// fields as a form a person reads; editing happens in the source editor,
// which commits to a branch and opens a pull request (mockup agent.md: "every
// field on the Definition tab is a view of the TOML file").
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import { moneyFromMicros } from "@/data/contracts/money";
import type { SafePath } from "@/shared/safe-path";
import {
  parseTomlSubset,
  type TomlTable,
  type TomlValue,
  tomlGet,
} from "@/shared/toml-subset";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { SafeLink } from "@/ui/navigation";
import { Facts, Instant, Panel } from "./parts";

/** The file's budget keys carry micros only; USD is the currency the store records (ADR-057 decision 2). */
const BUDGET_CURRENCY = "USD";

const text = (value: TomlValue | undefined): string | null =>
  typeof value === "string" ? value : null;

const strings = (value: TomlValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const table = (value: TomlValue | undefined): TomlTable | null =>
  typeof value === "object" && !Array.isArray(value) ? value : null;

function Fields({ doc }: { doc: TomlTable }) {
  const t = useTranslations("agents.detail.definition.fields");
  const unset = <span className="text-muted-foreground">{t("unset")}</span>;
  const word = (value: string | null): ReactNode =>
    value === null ? unset : <span className={mono}>{value}</span>;
  const chips = (values: string[]): ReactNode =>
    values.length === 0 ? (
      unset
    ) : (
      <ul className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <li
            key={value}
            className={`${mono} rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs`}
          >
            {value}
          </li>
        ))}
      </ul>
    );
  const budget = table(tomlGet(doc, "budget"));
  const perRun =
    budget === null ? undefined : tomlGet(budget, "per_run_micros");
  const instructions = table(tomlGet(doc, "instructions"));
  const body =
    instructions === null ? null : text(tomlGet(instructions, "body"));
  const harness = table(tomlGet(doc, "harness"));
  return (
    <Panel id="definition-fields" title={t("title")}>
      <Facts
        rows={[
          { term: t("schema"), value: word(text(tomlGet(doc, "schema"))) },
          { term: t("slug"), value: word(text(tomlGet(doc, "slug"))) },
          { term: t("name"), value: text(tomlGet(doc, "name")) ?? unset },
          {
            term: t("description"),
            value: text(tomlGet(doc, "description")) ?? unset,
          },
          {
            term: t("modelTier"),
            value: word(text(tomlGet(doc, "model_tier"))),
          },
          {
            term: t("budget"),
            value:
              typeof perRun === "number" &&
              Number.isSafeInteger(perRun) &&
              perRun >= 0 ? (
                <Money
                  value={moneyFromMicros(String(perRun), BUDGET_CURRENCY)}
                />
              ) : (
                unset
              ),
          },
          { term: t("tools"), value: chips(strings(tomlGet(doc, "tools"))) },
          {
            term: t("denyTools"),
            value: chips(strings(tomlGet(doc, "deny_tools"))),
          },
          {
            term: t("sideEffects"),
            value: chips(strings(tomlGet(doc, "side_effects"))),
          },
          {
            term: t("harness"),
            value: chips(harness === null ? [] : Object.keys(harness)),
          },
          {
            term: t("instructions"),
            value:
              body === null ? (
                unset
              ) : (
                <pre className={`${mono} whitespace-pre-wrap text-xs`}>
                  {body}
                </pre>
              ),
          },
        ]}
      />
    </Panel>
  );
}

export function DefinitionSection({
  definition,
  slug,
  editor,
}: {
  definition: AgentDetail["definition"];
  slug: string;
  /** The source editor for this agent's file. */
  editor: SafePath;
}) {
  const t = useTranslations("agents.detail.definition");
  const open = (
    <SafeLink to={editor} className={`${buttonSecondary} self-start`}>
      {t("openEditor")}
    </SafeLink>
  );
  if (definition === null) {
    return (
      <Panel id="definition-none" title={t("none.title")}>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("none.body", { slug })}
        </p>
        {open}
      </Panel>
    );
  }
  const parsed = parseTomlSubset(definition.source);
  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      {parsed.ok ? (
        <Fields doc={parsed.doc} />
      ) : (
        <Panel id="definition-fields" title={t("fields.title")}>
          <p data-testid="definition-unparsed" className="text-sm">
            {t("unparsed", { line: parsed.line })}
          </p>
        </Panel>
      )}
      <Panel
        id="definition-source"
        title={t("source.title")}
        lead={t("source.lead")}
      >
        <Facts
          rows={[
            {
              term: t("source.path"),
              value: <span className={mono}>{definition.path}</span>,
            },
            {
              term: t("source.branch"),
              value: <span className={mono}>{definition.branch}</span>,
            },
            {
              term: t("source.commit"),
              value: <span className={mono}>{definition.commitSha}</span>,
            },
            {
              term: t("source.digest"),
              value: (
                <span className={`${mono} break-all`}>{definition.digest}</span>
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
        {open}
      </Panel>
    </div>
  );
}
