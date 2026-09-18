"use client";
// The freshness panel on the Steering page: what this workspace has
// published, where it lives, and the two gates every agent its members run
// answers to.
//
// The gates are the point. A Context PR merges a record onto the production
// branch, and a developer on a feature branch keeps whatever `.oxagen/` their
// branch point had, so without these two switches the longer a branch lives
// the more likely the agent on it is steering on records nobody uses any
// more. `oxagen steering hooks install` puts the check in front of the
// prompt on the developer's machine; these decide what it does when it finds
// the checkout behind.
//
// Each checkbox writes on its own, and the panel shows the value it wrote
// rather than waiting for a reload. A refusal is named where the person
// clicked and the checkbox goes back to what it was, because a switch that
// looks set and is not is the one failure this panel cannot afford.
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { SteeringFreshness } from "@/data/contracts/steering";
import { FormAlert } from "@/ui/form-feedback";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { setSteeringGate } from "./actions";
import { Fact, Facts, Section, useDate } from "./section";

type Gate = "autoSync" | "blockStaleRuns";

export function Freshness({
  at,
  read,
  canEdit,
}: {
  at: { org: string; ws: string };
  read: SteeringFreshness;
  /** False for a viewer the handler would refuse; the boxes render disabled. */
  canEdit: boolean;
}) {
  const t = useTranslations("steering.freshness");
  const date = useDate();
  const failureText = useActionFailure();
  const [gates, setGates] = useState(read.gates);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(gate: Gate, next: boolean): void {
    const previous = gates[gate];
    // Optimistic, then reverted on a refusal. The write is one click and the
    // round trip is a kernel call, so showing the old value until it returns
    // reads as an unresponsive checkbox.
    setGates((current) => ({ ...current, [gate]: next }));
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await setSteeringGate(at.org, at.ws, gate, next);
        if (result.ok) {
          setGates(result.value);
          return;
        }
        setGates((current) => ({ ...current, [gate]: previous }));
        setFailure(failureText(result));
      } catch {
        setGates((current) => ({ ...current, [gate]: previous }));
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  const bound = read.repository !== null;

  return (
    <Section id="steering-freshness" title={t("title")} lead={t("lead")}>
      <Facts>
        <Fact name="version" term={t("version")}>
          {read.version}
        </Fact>
        <Fact name="repository" term={t("repository")}>
          {bound ? (
            <span className="font-mono text-xs">
              {read.repository}
              {read.defaultBranch === null ? "" : ` · ${read.defaultBranch}`}
            </span>
          ) : (
            t("unbound")
          )}
        </Fact>
        {read.headCommit === null ? null : (
          <Fact name="published" term={t("published")}>
            <span className="font-mono text-xs">
              {read.headCommit.slice(0, 7)}
            </span>
            {read.publishedAt === null ? null : ` · ${date(read.publishedAt)}`}
          </Fact>
        )}
      </Facts>

      <fieldset
        className="flex flex-col gap-3"
        // Both gates act on the production branch of a repository. Until one
        // is bound there is no branch to be behind, so the switches are shown
        // and disabled rather than hidden: a person looking for them should
        // find them, and find out why they are not available yet.
        disabled={!bound || !canEdit || pending}
      >
        <legend className="sr-only">{t("gatesLegend")}</legend>
        <GateBox
          name="autoSync"
          checked={gates.autoSync}
          label={t("autoSync")}
          hint={t("autoSyncHint")}
          onChange={(next) => toggle("autoSync", next)}
        />
        <GateBox
          name="blockStaleRuns"
          checked={gates.blockStaleRuns}
          label={t("blockStaleRuns")}
          hint={t("blockStaleRunsHint")}
          onChange={(next) => toggle("blockStaleRuns", next)}
        />
      </fieldset>

      {failure === null ? null : <FormAlert>{failure}</FormAlert>}
    </Section>
  );
}

function GateBox({
  name,
  checked,
  label,
  hint,
  onChange,
}: {
  name: Gate;
  checked: boolean;
  label: string;
  hint: string;
  onChange: (next: boolean) => void;
}) {
  const hintId = `steering-gate-${name}-hint`;
  return (
    <div className="flex gap-3">
      <input
        id={`steering-gate-${name}`}
        data-gate={name}
        type="checkbox"
        checked={checked}
        aria-describedby={hintId}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        className="mt-0.5 size-4"
      />
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`steering-gate-${name}`}
          className="text-sm text-foreground"
        >
          {label}
        </label>
        <p id={hintId} className="max-w-prose text-sm text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}
