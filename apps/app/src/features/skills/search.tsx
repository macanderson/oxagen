"use client";

import { useState, useTransition, type SyntheticEvent } from "react";
import { useTranslations } from "next-intl";
import type {
  SkillConfiguration,
  SkillSearchPreview,
} from "@/data/contracts/skills";
import {
  buttonPrimary,
  inputBase,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { previewSkillSearch } from "./actions";
import { UNANSWERED, useSkillFailure } from "./action-failure";

export function SkillSearch({
  at,
  configuration,
}: {
  at: { org: string; ws: string };
  configuration: SkillConfiguration;
}) {
  const t = useTranslations("skills.console");
  const failureText = useSkillFailure();
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(configuration.current?.version ?? "");
  const [result, setResult] = useState<SkillSearchPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !version || !query.trim()) return;
    setFailure(null);
    setResult(null);
    startTransition(async () => {
      try {
        const response = await previewSkillSearch(
          at.org,
          at.ws,
          version,
          query.trim(),
        );
        if (response.ok) setResult(response.value);
        else setFailure(failureText(response));
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  return (
    <section className={panel} aria-labelledby="skill-search-title">
      <header className={panelHeader}>
        <h2 className={panelTitle} id="skill-search-title">
          {t("searchTitle")}
        </h2>
      </header>
      <div className={`${panelBody} flex flex-col gap-4`}>
        <p className="text-sm text-muted-foreground">{t("searchLead")}</p>
        {configuration.current === null ? <p>{t("unpublished")}</p> : null}
        <form
          onSubmit={submit}
          className="flex flex-col gap-3"
          aria-busy={pending}
        >
          <label htmlFor="skill-search-version">{t("version")}</label>
          <select
            className={inputBase}
            id="skill-search-version"
            value={version}
            disabled={pending}
            onChange={(event) => {
              setVersion(event.target.value);
              setResult(null);
            }}
          >
            <option value="">{t("selectVersion")}</option>
            {configuration.versions.map((row) => (
              <option key={row.id} value={row.version}>
                {row.version}
              </option>
            ))}
          </select>
          <label htmlFor="skill-search-query">{t("query")}</label>
          <input
            className={inputBase}
            id="skill-search-query"
            value={query}
            maxLength={2000}
            disabled={pending}
            onChange={(event) => {
              setQuery(event.target.value);
              setResult(null);
            }}
          />
          <button
            className={`${buttonPrimary} self-start`}
            type="submit"
            disabled={pending || !version || !query.trim()}
          >
            {pending ? t("searchPending") : t("search")}
          </button>
        </form>
        {failure ? <FormAlert>{failure}</FormAlert> : null}
        {result ? (
          <div role="status" className="flex flex-col gap-3">
            <p className="text-sm">
              {t("searchContext", {
                version: result.version,
                commit: result.repositoryCommitSha.slice(0, 12),
                tokens: result.tokenCost,
              })}
            </p>
            {result.results.length === 0 ? (
              <p>{t("noMatches")}</p>
            ) : (
              <ul aria-label={t("matches")} className="divide-y divide-border">
                {result.results.map((skill) => (
                  <li
                    key={`${skill.source}/${skill.id}@${skill.version}`}
                    className="flex flex-col gap-1 py-3"
                  >
                    <p className={mono}>
                      {skill.id}@{skill.version}
                    </p>
                    <p className="text-sm">{skill.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("score", {
                        score: skill.score,
                        tokens: skill.tokenCost,
                        source: skill.source,
                      })}
                    </p>
                    <code className="break-all text-xs">{skill.digest}</code>
                  </li>
                ))}
              </ul>
            )}
            <h3 className={panelTitle}>
              {t("withheld", { count: result.withheld.length })}
            </h3>
            <p className="text-xs text-muted-foreground">{t("withheldLead")}</p>
            <ul aria-label={t("heldList")} className="divide-y divide-border">
              {result.withheld.map((skill) => (
                <li
                  key={`${skill.source}/${skill.id}@${skill.version}`}
                  className="flex flex-wrap gap-2 py-2 text-sm"
                >
                  <code>
                    {skill.id}@{skill.version}
                  </code>
                  <span>{t(skill.reason)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
