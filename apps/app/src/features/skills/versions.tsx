"use client";

import { useState, useTransition, type SyntheticEvent } from "react";
import { useTranslations } from "next-intl";
import type {
  SkillConfiguration,
  SkillConfigChange,
} from "@/data/contracts/skills";
import type { ActionResult } from "@/server/kernel";
import {
  parsePullRequestUrl,
  type PullRequestUrl,
} from "@/shared/pull-request-url";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { Badge } from "@/ui/badge";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import {
  importSkillConfig,
  proposeSkillConfig,
  publishSkillConfig,
} from "./actions";
import { UNANSWERED, useSkillFailure } from "./action-failure";

export function SkillVersions({
  at,
  configuration,
  canEdit,
}: {
  at: { org: string; ws: string };
  configuration: SkillConfiguration;
  canEdit: boolean;
}) {
  const t = useTranslations("skills.console");
  const format = useFormatter();
  const navigate = useNavigate();
  const failureText = useSkillFailure();
  const [text, setText] = useState(configuration.draftText);
  const [pr, setPr] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    number: number;
    url: PullRequestUrl;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  // A publication refreshes this page, whether it came from the form below or
  // from another admin. The refreshed configuration carries the version now
  // published and its normalized text, so the draft adopts that text: a draft
  // held from before the publication proposes reverting what was just
  // published (#3666).
  const currentId = configuration.current?.id ?? null;
  const [publishedId, setPublishedId] = useState(currentId);
  if (publishedId !== currentId) {
    setPublishedId(currentId);
    setText(configuration.draftText);
  }

  function write(action: () => Promise<ActionResult<SkillConfigChange>>) {
    if (pending || !canEdit) return;
    setFailure(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setFailure(failureText(result));
          return;
        }
        if (result.value.pullRequest) {
          const url = parsePullRequestUrl(result.value.pullRequest.url);
          setProposal(
            url ? { number: result.value.pullRequest.number, url } : null,
          );
          setPr(String(result.value.pullRequest.number));
          setNotice(t("proposed", { number: result.value.pullRequest.number }));
        }
        if (result.value.published) {
          setNotice(
            t("published", { version: result.value.published.version }),
          );
          navigate.refresh();
        }
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }
  function propose(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;
    write(() => proposeSkillConfig(at.org, at.ws, text));
  }
  function publish(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr))) return;
    write(() => publishSkillConfig(at.org, at.ws, Number(pr)));
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={panel} aria-labelledby="skill-config-title">
        <header className={panelHeader}>
          <h2 id="skill-config-title" className={panelTitle}>
            {t("configTitle")}
          </h2>
          <span className="text-xs">
            {configuration.config.enabled ? t("enabled") : t("disabled")}
          </span>
        </header>
        <div className={`${panelBody} flex flex-col gap-4`}>
          <p className="text-sm text-muted-foreground">{t("configLead")}</p>
          {!canEdit ? <p className="text-sm">{t("readOnly")}</p> : null}
          {configuration.current === null ? (
            <div className="flex flex-col items-start gap-2">
              <p>{t("unpublished")}</p>
              <button
                type="button"
                className={buttonSecondary}
                disabled={!canEdit || pending}
                onClick={() => {
                  write(() => importSkillConfig(at.org, at.ws));
                }}
              >
                {t("import")}
              </button>
            </div>
          ) : null}
          <form
            onSubmit={propose}
            className="flex flex-col gap-3"
            aria-busy={pending}
          >
            <label htmlFor="skill-config-text">{t("toml")}</label>
            <textarea
              id="skill-config-text"
              className={`${inputBase} font-mono`}
              rows={18}
              maxLength={200000}
              value={text}
              readOnly={!canEdit}
              disabled={pending}
              onChange={(event) => {
                setText(event.target.value);
              }}
              aria-describedby="skill-config-draft-hint"
            />
            <p
              id="skill-config-draft-hint"
              className="text-xs text-muted-foreground"
            >
              {t("normalized")}
            </p>
            <button
              type="submit"
              className={`${buttonPrimary} self-start`}
              disabled={!canEdit || pending || !text.trim()}
            >
              {pending ? t("working") : t("propose")}
            </button>
          </form>
          {failure ? <FormAlert>{failure}</FormAlert> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {proposal ? (
            <PullRequestLink to={proposal.url}>
              {t("reviewPr", { number: proposal.number })}
            </PullRequestLink>
          ) : null}
          <form
            onSubmit={publish}
            className="flex flex-col gap-3"
            aria-busy={pending}
          >
            <p className="text-sm text-muted-foreground">{t("publishLead")}</p>
            <label htmlFor="skill-config-pr">{t("prNumber")}</label>
            <input
              id="skill-config-pr"
              className={inputBase}
              inputMode="numeric"
              pattern="[1-9][0-9]*"
              value={pr}
              disabled={!canEdit || pending}
              onChange={(event) => {
                setPr(event.target.value);
              }}
            />
            <button
              type="submit"
              className={`${buttonSecondary} self-start`}
              disabled={!canEdit || pending || !/^[1-9]\d*$/.test(pr)}
            >
              {t("publish")}
            </button>
          </form>
        </div>
      </section>
      <section className={panel} aria-labelledby="skill-versions-title">
        <header className={panelHeader}>
          <h2 id="skill-versions-title" className={panelTitle}>
            {t("history")}
          </h2>
        </header>
        {configuration.versions.length === 0 ? (
          <p className={panelBody}>{t("noVersions")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {configuration.versions.map((row) => (
              <li key={row.id} className={`${panelBody} flex flex-col gap-1`}>
                <p className={`${mono} flex flex-wrap items-center gap-2`}>
                  <span>{row.version}</span>
                  {configuration.current?.id === row.id ? (
                    <Badge tone="quiet">{t("current")}</Badge>
                  ) : null}
                </p>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>
                    {format.dateTime(new Date(row.publishedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                  <span>
                    {row.pullRequestNumber === null
                      ? t("imported")
                      : t("pr", { number: row.pullRequestNumber })}
                  </span>
                </p>
                <code className="break-all text-xs">{row.commitSha}</code>
                <code className="break-all text-xs">{row.digest}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
