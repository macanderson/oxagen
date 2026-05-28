import type { CapabilityContext } from "../types.js";
import type {
  ChatMessageSendInput,
  ChatMessageSendOutput,
} from "./chat.message.send.js";

export async function chatMessageSendHandler(
  _input: ChatMessageSendInput,
  _ctx: CapabilityContext,
): Promise<ChatMessageSendOutput> {
  throw new Error("not implemented");
}
