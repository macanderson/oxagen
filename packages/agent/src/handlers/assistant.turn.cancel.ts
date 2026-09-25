// cancel_assistant_turn: stop a running `ask_assistant` turn by the id its
// caller minted (#4164). The contract's header has the behaviour a caller
// sees. This file is the authorization.
//
// The turn is looked up by organisation, workspace, acting user and turn id
// together. The acting user is resolved the way `ask_assistant` resolves it
// (the signed-in user, or the creator of the API key), so a turn asked by key
// is stopped by the same key or by its creator's session. Another person's
// stop builds another key and never matches, so no role check is needed on
// top: a stop can only ever reach the caller's own turn. A caller with no
// person behind it cannot have asked, and is refused the same way ask is.
import type {
  AssistantTurnCancelInput,
  AssistantTurnCancelOutput,
} from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import { HandlerError } from "@oxagen/oxagen";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { stopAssistantTurn } from "../runtime/assistant-turn-registry";
import type { CapabilityContext } from "../types";

export async function assistantTurnCancelHandler(
  input: AssistantTurnCancelInput,
  ctx: CapabilityContext,
): Promise<AssistantTurnCancelOutput> {
  const userId = await resolveActingUserId(ctx);
  if (!userId) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  const { found } = stopAssistantTurn({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    turnId: input.turnId,
  });
  return { turnId: input.turnId, found };
}
