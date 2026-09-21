// The wizards the host carries, one module per kind (roadmap creation-spec §1).
// A kind is offered in the chooser and in ⌘K once it is in `CREATE_KINDS`
// (`@/shared/create`) and has a module here; the test beside this file holds
// the two lists together, so a kind can never be offered with no wizard
// behind it.
import type { CreateKind } from "@/shared/create";
import { type AnyWizardKind, wizardKind } from "./wizard";

// One import per kind while it is in flight or has landed, and none kept
// after a rejection: a tab opened before a deployment asks for a chunk that is
// no longer served, and a cached rejection would answer every later attempt
// with the same failure until the page is reloaded.
function once(
  load: () => Promise<AnyWizardKind>,
): () => Promise<AnyWizardKind> {
  let pending: Promise<AnyWizardKind> | undefined;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

// Only the selected wizard enters the client graph. In particular, YAML stays
// with skill editing instead of loading with every workspace's creation host.
export const WIZARDS: Partial<
  Record<CreateKind, () => Promise<AnyWizardKind>>
> = {
  agent: once(() =>
    import("./agent-wizard").then((m) => wizardKind(m.agentWizard)),
  ),
  skill: once(() =>
    import("./skill-wizard").then((m) => wizardKind(m.skillWizard)),
  ),
  record: once(() =>
    import("./record-wizard").then((m) => wizardKind(m.recordWizard)),
  ),
};
