"use client";
// The steering PR page's two host controls (#5077).
//
// Refresh from GitHub reads the pull request from the host now and moves the
// proposal to the host's state (refresh_steering_pr; ADR-184). It runs once
// when the page opens, so a missed webhook never leaves the page showing a
// state the host does not agree with, and again whenever the person presses
// it. A move reloads the page. A merge on the host is published by the
// repository sync, so the control says the host merged it while the page
// waits for the sync. A refusal is named beside the button and moves nothing.
//
// Clone lists the commands that check the branch out: git clone, git switch,
// and gh pr checkout on GitHub.
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { refreshSteeringPr } from "./actions";

type Target = { org: string; ws: string; proposalId: string };

/** What the last refresh found, when it found something worth saying. */
type Found = "mergedOnHost" | "moved" | "current" | null;

export function RefreshFromHost({
  org,
  ws,
  proposalId,
  host,
  auto = true,
}: Target & {
  /** The host's name as the button says it. */
  host: "github" | "gitlab";
  /** Refresh once when the page opens. */
  auto?: boolean;
}) {
  const t = useTranslations("steering.pr.refresh");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [found, setFound] = useState<Found>(null);
  const ranRef = useRef(false);

  // The refresh on open: once per page, setting no state until the host
  // answers. A viewer whose role cannot refresh still reads the page, so a
  // refusal here stays quiet; pressing the button says why.
  useEffect(() => {
    if (!auto || ranRef.current) return;
    ranRef.current = true;
    void (async () => {
      try {
        const result = await refreshSteeringPr(org, ws, proposalId);
        if (!result.ok) {
          if (result.reason !== "denied") setFailure(failureText(result));
          return;
        }
        if (result.value.changed) {
          setFound("moved");
          navigate.refresh();
        } else if (result.value.syncRequested) {
          setFound("mergedOnHost");
        }
      } catch {
        // The button is still there; a refresh on open that did not answer
        // leaves the page as it loaded.
      }
    })();
  }, [auto, org, ws, proposalId, failureText, navigate]);

  async function refresh() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await refreshSteeringPr(org, ws, proposalId);
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      if (result.value.changed) {
        setFound("moved");
        navigate.refresh();
      } else {
        setFound(result.value.syncRequested ? "mergedOnHost" : "current");
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        data-testid="refresh-steering-pr"
        disabled={pending}
        aria-busy={pending ? "true" : undefined}
        variant="outline"
        onClick={() => {
          void refresh();
        }}
      >
        {pending
          ? t("pending")
          : host === "gitlab"
            ? t("gitlab")
            : t("github")}
      </Button>
      {failure === null ? null : (
        <FormAlert testId="refresh-steering-pr-failure">{failure}</FormAlert>
      )}
      {found === null ? null : (
        <p
          role="status"
          data-found={found}
          className="text-sm text-muted-foreground"
        >
          {t(found)}
        </p>
      )}
    </div>
  );
}

export function CloneCommands({
  repositoryUrl,
  repository,
  branch,
  number,
  host,
}: {
  /** The repository's web address on the host, which git clones over HTTPS. */
  repositoryUrl: string;
  /** `owner/name`. */
  repository: string;
  branch: string;
  number: number;
  host: "github" | "gitlab";
}) {
  const t = useTranslations("steering.pr.clone");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const folder = repository.split("/").at(-1) ?? repository;
  const commands = [
    `git clone ${repositoryUrl}.git`,
    `cd ${folder}`,
    `git fetch origin ${branch}`,
    `git switch ${branch}`,
  ];
  const gh =
    host === "github"
      ? `gh pr checkout ${String(number)} --repo ${repository}`
      : null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <>
      <Button
        type="button"
        data-testid="clone-steering-pr"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </Button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setCopied("idle");
        }}
        title={t("title")}
        subtitle={branch}
        testId="clone-steering-pr-dialog"
        footer={
          <Button
            type="button"
            data-testid="clone-copy"
            variant="primary"
            onClick={() => {
              void copy(commands.join("\n"));
            }}
          >
            {copied === "copied" ? t("copied") : t("copy")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-base text-foreground">{t("lead")}</p>
          <pre
            data-testid="clone-commands"
            className="overflow-x-auto rounded-xl border border-border bg-code-bg px-3.5 py-3 font-mono text-sm leading-relaxed text-foreground"
          >
            {commands.join("\n")}
          </pre>
          {gh === null ? null : (
            <div className="flex flex-col gap-1.5">
              <p className="text-base text-foreground">{t("ghLead")}</p>
              <pre
                data-testid="clone-gh"
                className="overflow-x-auto rounded-xl border border-border bg-code-bg px-3.5 py-3 font-mono text-sm leading-relaxed text-foreground"
              >
                {gh}
              </pre>
              <Button
                type="button"
                data-testid="clone-copy-gh"
                variant="outline" className="self-start"
                onClick={() => {
                  void copy(gh);
                }}
              >
                {t("copyGh")}
              </Button>
            </div>
          )}
          {copied === "failed" ? (
            <p role="alert" className="text-sm text-error-ink">
              {t("copyFailed")}
            </p>
          ) : null}
        </div>
      </SheetDialog>
    </>
  );
}
