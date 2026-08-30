import type { z } from "zod";
import type {
  agentArtifactSchema,
  artifactSchema,
  commandArtifactSchema,
  skillArtifactSchema,
} from "./schemas";

export type Artifact = z.infer<typeof artifactSchema>;
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;
export type SkillArtifact = z.infer<typeof skillArtifactSchema>;
export type CommandArtifact = z.infer<typeof commandArtifactSchema>;
export type ArtifactKind = Artifact["kind"];

/**
 * Whether an artifact may be used as-is. `needs_review` means it validated but
 * still carries unmapped tool names (`unresolved_tools`); the lifecycle
 * compiler refuses to build a plan from one.
 */
export type ArtifactReadiness = "ready" | "needs_review" | "rejected";
