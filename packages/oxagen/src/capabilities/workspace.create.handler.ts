import type { CapabilityContext } from "../types.js";
import type {
  WorkspaceCreateInput,
  WorkspaceCreateOutput,
} from "./workspace.create.js";

export async function workspaceCreateHandler(
  _input: WorkspaceCreateInput,
  _ctx: CapabilityContext,
): Promise<WorkspaceCreateOutput> {
  throw new Error("not implemented");
}
