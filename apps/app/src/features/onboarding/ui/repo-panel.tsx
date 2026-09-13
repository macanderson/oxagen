"use client";
// Gate step 3's second card: the repository the installer read from the git
// remote of the directory it ran in (spec §4.4). One click binds it as the main
// repo; skipping leaves the workspace provisional for 14 days.
// Fixture only: outside fixture mode the page renders NotBacked (G15) instead.
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import type { DetectedRepository } from "../model";

type Choice = "open" | "bound" | "skipped";

export function RepoPanel({ repo }: { repo: DetectedRepository }) {
  const t = useTranslations("onboarding.repo");
  const [choice, setChoice] = useState<Choice>("open");

  if (choice === "bound") {
    return (
      <section
        aria-labelledby="repo-bound-title"
        data-testid="repo-bound"
        className={`${panel} mt-4 p-4`}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="rounded border border-success/50 bg-success/10 px-2 py-0.5 text-xs font-semibold text-foreground">
            {t("bound")}
          </span>
          <h2
            id="repo-bound-title"
            className="text-sm font-semibold text-foreground"
          >
            {t("boundTitle")}
          </h2>
          <span
            className={`${mono} rounded border border-border px-1.5 py-0.5 text-xs text-foreground`}
          >
            {repo.fullName}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("boundNote", { repo: repo.fullName })}
        </p>
      </section>
    );
  }

  if (choice === "skipped") {
    return (
      <section
        aria-labelledby="repo-skipped-title"
        data-testid="repo-skipped"
        className={`${panel} mt-4 p-4`}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="rounded border border-warning/60 bg-warning/10 px-2 py-0.5 text-xs font-semibold text-foreground">
            {t("provisional")}
          </span>
          <h2
            id="repo-skipped-title"
            className="text-sm font-semibold text-foreground"
          >
            {t("provisionalTitle")}
          </h2>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("skipNote", { days: repo.provisionalDays })}
        </p>
        <button
          type="button"
          className={`${buttonSecondary} min-h-8 px-3 py-1 text-xs`}
          onClick={() => {
            setChoice("bound");
          }}
        >
          {t("bindNow", { repo: repo.fullName })}
        </button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="repo-detected-title"
      data-testid="repo-detected"
      className={`${panel} mt-4 overflow-hidden`}
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <h2
          id="repo-detected-title"
          className="text-sm font-semibold text-foreground"
        >
          {t("detected")}
        </h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("reported")}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <span
          className={`${mono} w-fit max-w-full rounded border border-border px-1.5 py-0.5 text-xs text-foreground [overflow-wrap:anywhere]`}
        >
          {repo.remote}
        </span>
        <p className="text-sm text-muted-foreground">
          {t("readFrom", { directory: repo.directory, branch: repo.branch })}
        </p>
        <button
          type="button"
          className={`${buttonPrimary} w-fit`}
          onClick={() => {
            setChoice("bound");
          }}
        >
          {t("bind", { repo: repo.fullName })}
        </button>
        <p className="text-sm text-muted-foreground">
          {t("bindNote", { repo: repo.fullName })}
        </p>
        <div className="border-t border-border pt-3 text-sm text-muted-foreground">
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              setChoice("skipped");
            }}
          >
            {t("skip")}
          </button>{" "}
          {t("skipNote", { days: repo.provisionalDays })}
        </div>
      </div>
    </section>
  );
}
