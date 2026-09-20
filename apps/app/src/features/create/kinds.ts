// The wizards the host carries, one module per kind (roadmap creation-spec §1).
// A kind is offered in the chooser and in ⌘K once it is in `CREATE_KINDS`
// (`@/shared/create`) and has a module here; the test beside this file holds
// the two lists together, so a kind can never be offered with no wizard
// behind it.
import type { CreateKind } from "@/shared/create";
import { agentWizard } from "./agent-wizard";
import { recordWizard } from "./record-wizard";
import { skillWizard } from "./skill-wizard";
import { type AnyWizardKind, wizardKind } from "./wizard";

export const WIZARDS: Partial<Record<CreateKind, AnyWizardKind>> = {
  agent: wizardKind(agentWizard),
  skill: wizardKind(skillWizard),
  record: wizardKind(recordWizard),
};
