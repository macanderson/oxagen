// The ways to a new agent (agents.md, Header; ADR-198). An agent is one
// operator on one runtime with one harness, so every way to a new agent is the
// register flow. Connect an agent opens it at its first step; in the Agents
// page header it is the page's one gold action, and in the empty state, under
// that header, it is drawn in the default style. Add a runtime leaves for the
// Runtimes tab, where naming a runtime goes straight on to registering its
// agent.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

type Place = { org: string; ws: string };

export function ConnectAgentLink({
  org,
  ws,
  primary = true,
}: Place & {
  /** Gold only in the page header, where it is the page's one primary action. */
  primary?: boolean;
}) {
  const t = useTranslations("agents.list.create");
  return (
    <SafeLink
      to={routes.register(org, ws, "name")}
      className={primary ? buttonPrimary : buttonSecondary}
      data-testid="agents-register"
    >
      {t("register")}
    </SafeLink>
  );
}

export function AddRuntimeLink({ org, ws }: Place) {
  const t = useTranslations("agents.list.create");
  return (
    <SafeLink
      to={routes.runtimes(org, ws)}
      className={buttonSecondary}
      data-testid="agents-add-runtime"
    >
      {t("addRuntime")}
    </SafeLink>
  );
}
