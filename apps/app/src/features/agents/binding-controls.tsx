"use client";
// The two writes that change what an agent is bound to (ADR-192): give it
// another toolbelt (`assign_agent_toolbelt`, on the Toolbelt tab) and move it
// to another runtime (`move_agent`, on the Runtime tab). Each writes a new
// agent version; the principal, its roles and its runs stay.
//
// Both pickers are option cards. On the move, a runtime that already runs a
// live agent with this agent's harness stays in the list, disabled, with a
// popover naming the agent that holds it, and the runtime the agent is on now
// says so. A viewer the handlers would refuse (not an org Owner or Admin) sees
// the current binding and who can change it, and no control.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type {
  AgentHarness,
  RuntimeRef,
  ToolbeltRef,
} from "@/data/contracts/agents";
import type { NamedRuntimeList } from "@/data/contracts/runtimes";
import type { ToolbeltList } from "@/data/contracts/toolbelts";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { ChoiceGroup } from "@/ui/choice-group";
import { buttonPrimary, linkText, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { assignAgentToolbelt, moveAgent } from "./actions";
import { Panel } from "./parts";

type Place = { org: string; ws: string; agent: string };

export function ToolbeltChoice({
  place,
  current,
  belts,
  canChange,
}: {
  place: Place;
  /** The belt the agent carries now; null only before the workspace has one. */
  current: ToolbeltRef | null;
  belts: Read<ToolbeltList>;
  /** Whether the viewer may change it (an org Owner or Admin). */
  canChange: boolean;
}) {
  const t = useTranslations("agents.detail.binding.toolbelt");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(current?.id ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    if (pending || chosen === null || chosen === current?.id) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await assignAgentToolbelt(
        place.org,
        place.ws,
        place.agent,
        chosen,
      );
      if (result.ok) {
        setDone(result.value.version);
        navigate.refresh();
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel
      id="agent-belt-choice"
      title={t("title")}
      lead={t("lead")}
      testId="agent-belt-choice"
      aside={
        <SafeLink
          to={routes.tools(place.org, place.ws, { tab: "toolbelts" })}
          className={linkText}
        >
          {t("manage")}
        </SafeLink>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 text-sm">
        <p data-testid="agent-belt-current">
          {current === null
            ? t("currentNone")
            : t("current", { belt: current.name })}
        </p>
        {!canChange ? (
          <p className="text-muted-foreground">{t("needsRole")}</p>
        ) : !belts.ok ? (
          <ReadFailure read={belts} section={t("title")} />
        ) : (
          <>
            <ChoiceGroup
              label={t("title")}
              testId="agent-belt"
              value={chosen}
              onChange={(id) => {
                setChosen(id);
                setDone(null);
              }}
              options={belts.value.belts.map((belt) => ({
                value: belt.id,
                label: belt.name,
                sub: t("tools", { count: belt.activeTools }),
              }))}
            />
            {failure === null ? null : (
              <FormAlert testId="agent-belt-failure">{failure}</FormAlert>
            )}
            {done === null ? null : (
              <p role="status" data-testid="agent-belt-done">
                {t("done", { version: done })}
              </p>
            )}
            <button
              type="button"
              data-testid="agent-belt-save"
              aria-disabled={
                pending || chosen === null || chosen === current?.id
                  ? true
                  : undefined
              }
              className={`${buttonPrimary} self-start`}
              onClick={() => void save()}
            >
              {pending ? t("pending") : t("save")}
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}

export function RuntimeMove({
  place,
  agentId,
  harness,
  current,
  runtimes,
  canMove,
}: {
  place: Place;
  /** `agt_…`, to tell this agent from another on the same runtime. */
  agentId: string;
  harness: AgentHarness;
  /** The runtime the agent runs on now; null when it runs on no named one. */
  current: RuntimeRef | null;
  runtimes: Read<NamedRuntimeList>;
  /** Whether the viewer may move it (an org Owner or Admin). */
  canMove: boolean;
}) {
  const t = useTranslations("agents.detail.binding.runtime");
  const harnessT = useTranslations("agents.harness");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<{
    version: number;
    revokedHosts: number;
  } | null>(null);
  const [pending, setPending] = useState(false);

  async function move() {
    if (pending || chosen === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await moveAgent(place.org, place.ws, place.agent, chosen);
      if (result.ok) {
        setDone(result.value);
        setChosen(null);
        navigate.refresh();
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel
      id="agent-runtime-move"
      title={t("title")}
      lead={t("lead")}
      testId="agent-runtime-move"
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 text-sm">
        <p data-testid="agent-runtime-current">
          {current === null ? (
            t("currentNone")
          ) : (
            <>
              {t("current", { runtime: current.name })}{" "}
              <span className={`${mono} text-xs text-muted-foreground`}>
                {current.slug}
              </span>
            </>
          )}
        </p>
        {!canMove ? (
          <p className="text-muted-foreground">{t("needsRole")}</p>
        ) : !runtimes.ok ? (
          <ReadFailure read={runtimes} section={t("title")} />
        ) : (
          <>
            <ChoiceGroup
              label={t("title")}
              testId="agent-runtime"
              value={chosen}
              onChange={(id) => {
                setChosen(id);
                setDone(null);
              }}
              options={runtimes.value.runtimes.map((runtime) => {
                const holder = runtime.agents.find(
                  (agent) => agent.harness === harness && agent.id !== agentId,
                );
                return {
                  value: runtime.id,
                  label: runtime.name,
                  sub: runtime.slug,
                  disabledReason:
                    runtime.id === current?.id
                      ? t("here")
                      : holder === undefined
                        ? null
                        : t("taken", {
                            harness: harnessT(harness),
                            runtime: runtime.name,
                            agent: holder.slug,
                          }),
                };
              })}
            />
            <p className="text-xs text-muted-foreground">{t("revokes")}</p>
            {failure === null ? null : (
              <FormAlert testId="agent-runtime-failure">{failure}</FormAlert>
            )}
            {done === null ? null : (
              <p role="status" data-testid="agent-runtime-done">
                {t("done", {
                  version: done.version,
                  hosts: done.revokedHosts,
                })}
              </p>
            )}
            <button
              type="button"
              data-testid="agent-runtime-save"
              aria-disabled={pending || chosen === null ? true : undefined}
              className={`${buttonPrimary} self-start`}
              onClick={() => void move()}
            >
              {pending ? t("pending") : t("move")}
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}
