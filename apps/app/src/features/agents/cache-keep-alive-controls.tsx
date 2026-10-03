"use client";
// The one write on an agent's cache keep-alive (lane F32): turn it off, or
// back on. While the agent waits on a subagent, the model proxy keeps its
// prompt cache warm when its idle cache finding shows a saving. The setting
// is on by default, and the owning team turns it off here for one agent.
//
// One button, no dialog: the write changes one boolean and the button that
// made it can change it back. The page re-reads once the write answers, so
// the state beside the button is the stored one. A refusal is named under
// the button and nothing else moves.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/ui/button";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { setAgentCacheKeepAlive } from "./actions";

/** Where the write happens, and the setting the agent holds now. */
type KeepAliveTarget = {
  org: string;
  ws: string;
  /** The agent's slug: what `set_agent_cache_keep_alive` names the agent by. */
  agentSlug: string;
  /** The setting the agent holds now. */
  on: boolean;
};

export function KeepAliveToggle({ org, ws, agentSlug, on }: KeepAliveTarget) {
  const t = useTranslations("agents.detail.overview.coaching.keepAlive");
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function change() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await setAgentCacheKeepAlive(org, ws, agentSlug, !on);
      if (result.ok) {
        navigate.refresh();
      } else {
        setFailure(result.reason === "denied" ? t("denied") : t("failed"));
      }
    } catch {
      setFailure(t("failed"));
    } finally {
      setPending(false);
    }
  }

  const label = on ? t("turnOff") : t("turnOn");
  const pendingLabel = on ? t("turningOff") : t("turningOn");
  return (
    <div className="mt-1.5 flex flex-col items-start gap-2">
      <Button
        type="button"
        data-testid="agent-keep-alive-change"
        aria-disabled={pending ? true : undefined}
        variant="outline"
        onClick={() => void change()}
      >
        {pending ? pendingLabel : label}
      </Button>
      {failure === null ? null : (
        <FormAlert testId="agent-keep-alive-failure">{failure}</FormAlert>
      )}
    </div>
  );
}
