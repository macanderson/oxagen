// The Agents header's three actions, in the spec's order (agents.md, Header):
// New agent opens the agent wizard, Register an agent opens the dialog that
// opens a Context PR, and Wrap Claude Code, the one gold action on the page,
// leaves for the Register Agent gate. The empty state carries the last two.
import { useTranslations } from "next-intl";
import { AGENT_HARNESSES, MODEL_TIERS } from "@/features/create";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { CreateButton } from "@/ui/create-button";
import { SafeLink } from "@/ui/navigation";
import { RegisterAgent } from "./register-agent";

type Place = { org: string; ws: string };

export function WrapClaudeCode({ org, ws }: Place) {
  const t = useTranslations("agents.list.create");
  return (
    <SafeLink
      to={routes.register(org, ws, "name")}
      className={buttonPrimary}
      data-testid="agents-wrap"
    >
      {t("wrap")}
    </SafeLink>
  );
}

export function RegisterAnAgent({ org, ws }: Place) {
  const t = useTranslations("agents.harness");
  return (
    <RegisterAgent
      org={org}
      ws={ws}
      harnesses={AGENT_HARNESSES.map((value) => ({ value, label: t(value) }))}
      tiers={MODEL_TIERS}
    />
  );
}

export function AgentsCreate({ org, ws }: Place) {
  const t = useTranslations("agents.list.create");
  return (
    <>
      <CreateButton kind="agent" label={t("newAgent")} primary={false} />
      <RegisterAnAgent org={org} ws={ws} />
      <WrapClaudeCode org={org} ws={ws} />
    </>
  );
}
