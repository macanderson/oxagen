// The Configuration section (ADR-057 decision 1): the file
// `.oxagen/agents/<slug>.toml` is the definition of record, and this section
// renders it as a form (mockup agent.md: "every field on the Definition tab
// is a view of the TOML file"). It reads the commit the last
// commit_agent_definition cached, or seeds a file for an agent with none, and
// hands the form the mandate list the irreversible side effect is gated on.
import { AGENT_DEFINITION_DIR } from "@oxagen/oxagen/contracts/agent.definition.commit";
import type { AgentDetail } from "@/data/contracts/agents";
import type { MandateList } from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { DefinitionForm } from "./definition-form";
import { definitionSeed } from "@/shared/agent-definition-seed";

export function DefinitionSection({
  detail,
  mandates,
  org,
  ws,
  editor,
  here,
}: {
  detail: AgentDetail;
  /** The agent's mandates; a failed read leaves the form not knowing, rather than believing there are none. */
  mandates: Read<MandateList>;
  org: string;
  ws: string;
  /** The source editor for this agent's file. */
  editor: SafePath;
  /** This tab, reloaded after a commit. */
  here: SafePath;
}) {
  const { identity, definition } = detail;
  return (
    <DefinitionForm
      org={org}
      ws={ws}
      identity={identity}
      definition={definition}
      path={definition?.path ?? `${AGENT_DEFINITION_DIR}/${identity.slug}.toml`}
      base={definition?.source ?? definitionSeed(identity)}
      branch={definition?.branch ?? `agents/${identity.slug}`}
      mandates={mandates.ok ? mandates.value : null}
      editor={editor}
      after={here}
    />
  );
}
