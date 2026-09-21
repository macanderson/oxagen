"use client";
import { useEffect, useState, type SyntheticEvent } from "react";
import { useTranslations } from "next-intl";
import type { ConfigurationCloneDraft } from "./clone-actions";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, PullRequestLink } from "@/ui/navigation";
import { routes } from "@/shared/safe-path";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { readCloneDraft, proposeClone } from "./clone-actions";
export function CloneEditor({
  org,
  ws,
  kind,
  sourceRef,
  onClose,
}: {
  org: string;
  ws: string;
  kind: ConfigurationCloneDraft["kind"];
  sourceRef: string;
  onClose: () => void;
}) {
  const t = useTranslations("create.clone");
  const [draft, setDraft] = useState<ConfigurationCloneDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [done, setDone] = useState<{
    slug: string;
    proposalId: string | null;
    pullRequest: { number: number; url: string } | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void readCloneDraft(org, ws, kind, sourceRef)
      .then((result) => {
        if (!active) return;
        if (result.ok) setDraft(result.value);
        else
          setFailure(
            result.reason === "denied" ? t("denied") : t("unavailable"),
          );
      })
      .catch(() => {
        if (active) setFailure(t("unavailable"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [org, ws, kind, sourceRef, retry, t]);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await proposeClone(org, ws, draft);
      if (result.ok) {
        if (
          result.value.pullRequest &&
          !parsePullRequestUrl(result.value.pullRequest.url)
        )
          setFailure(t("unavailable"));
        else setDone(result.value);
      } else
        setFailure(
          result.reason === "denied"
            ? t("denied")
            : ("code" in result ? result.code : "") === "clone_name_taken"
              ? t("collision")
              : ("code" in result ? result.code : "") === "clone_source_changed"
                ? t("changed")
                : t("refused"),
        );
    } catch {
      setFailure(t("unavailable"));
    } finally {
      setPending(false);
    }
  }
  const prUrl = done?.pullRequest
    ? parsePullRequestUrl(done.pullRequest.url)
    : null;
  return (
    <SheetDialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title={t("title")}
      testId="configuration-clone"
      wide
    >
      <p className="mb-3 text-sm text-muted-foreground">{t("lead")}</p>
      {loading ? (
        <p role="status">{t("loading")}</p>
      ) : done ? (
        <div role="status" className="flex flex-col gap-3">
          <p>{t("done", { name: done.slug })}</p>
          {prUrl ? (
            <PullRequestLink to={prUrl}>{t("viewPr")}</PullRequestLink>
          ) : (
            <SafeLink to={routes.steering(org, ws, { tab: "proposals" })}>
              {t("viewProposal")}
            </SafeLink>
          )}
        </div>
      ) : draft ? (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex flex-col gap-3"
        >
          <label>
            {t("slug")}
            <input
              className={inputBase}
              value={draft.slug}
              disabled={pending}
              onChange={(e) => {
                setDraft({
                  ...draft,
                  slug: e.target.value,
                  ...(kind === "skill" ? { name: e.target.value } : {}),
                });
              }}
            />
          </label>
          {kind === "skill" ? null : (
            <label>
              {t("name")}
              <input
                className={inputBase}
                value={draft.name}
                disabled={pending}
                onChange={(e) => {
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
            </label>
          )}
          <label>
            {t("source")}
            <textarea
              className={`${inputBase} ${mono} min-h-64`}
              value={draft.source}
              disabled={pending}
              onChange={(e) => {
                setDraft({ ...draft, source: e.target.value });
              }}
            />
          </label>
          {draft.files.length ? (
            <p>{t("companions", { count: draft.files.length })}</p>
          ) : null}
          {failure ? <FormAlert>{failure}</FormAlert> : null}
          <button
            type="submit"
            className={buttonPrimary}
            disabled={
              pending ||
              !draft.slug.trim() ||
              !draft.name.trim() ||
              !draft.source.trim()
            }
          >
            {pending ? t("pending") : t("submit")}
          </button>
        </form>
      ) : (
        <div>
          {failure ? <FormAlert>{failure}</FormAlert> : null}
          <button
            className={buttonSecondary}
            type="button"
            onClick={() => {
              setLoading(true);
              setFailure(null);
              setRetry((n) => n + 1);
            }}
          >
            {t("retry")}
          </button>
        </div>
      )}
    </SheetDialog>
  );
}
