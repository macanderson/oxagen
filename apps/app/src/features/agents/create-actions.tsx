// Agent IAM's header actions (mockups/pages/agents.md; roadmap creation-spec
// §1, the entry-point table). Two ways to get an agent, from opposite ends:
// New agent writes one that does not exist yet and opens its wizard over the
// page; Register an agent wraps one that already runs on a machine or in CI.
// Both end on a pull request. New agent is the gold action, the one the page
// is for; Register is the secondary link to its own flow.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { CreateButton } from "@/ui/create-button";
import { SafeLink } from "@/ui/navigation";

export function AgentsCreate({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("agents.list.create");
  return (
    <>
      <SafeLink
        to={routes.register(org, ws, "name")}
        className={buttonSecondary}
        data-testid="agents-register"
      >
        {t("register")}
      </SafeLink>
      <CreateButton kind="agent" label={t("newAgent")} />
    </>
  );
}
