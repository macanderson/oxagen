// The creation wizards' public surface (roadmap creation-spec §1-§2). The
// workspace layout renders <CreateHost> once; every entry point opens it
// through `openCreate` in `@/shared/create`, never by importing this folder.
export { CreateHost } from "./create-host";
// The agent file the wizard drafts, which the Agents list's Register an agent
// dialog opens a pull request with too, so the two entry points write one file.
export {
  AGENT_HARNESSES,
  type AgentHarness,
  draftAgentDefinition,
  isAgentSlug,
  MODEL_TIERS,
  type ModelTier,
} from "./agent-file";
