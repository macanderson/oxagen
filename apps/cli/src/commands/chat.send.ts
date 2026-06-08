import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

interface ChatResponse {
  content?: string;
  message?: string;
  text?: string;
}

export const chatSendCommand = new Command("send")
  .description("Send a message to the agent")
  .argument("<message>", "Message to send")
  .option("-c, --conversation <id>", "Conversation ID (resumes existing)")
  .option("--org <slug>", "Organization slug")
  .option("--workspace <slug>", "Workspace slug")
  .action(async (message: string, options: { conversation?: string; org?: string; workspace?: string }) => {
    requireAuth();
    console.log(`Sending: "${message}"`);
    try {
      const data = await apiRequest<ChatResponse>("/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          message,
          conversationId: options.conversation ?? null,
          org: options.org,
          workspace: options.workspace,
        }),
      });
      const response = data.content ?? data.message ?? data.text ?? "";
      console.log(`Response: ${response}`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
