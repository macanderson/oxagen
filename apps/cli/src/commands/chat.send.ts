import { Command } from "commander";

export const chatSendCommand = new Command("send")
  .description("Send a message to the agent")
  .argument("<message>", "Message to send")
  .action((message) => {
    console.log(`Sending: "${message}"`);
    // TODO: Implement streaming response
    console.log("Response: Hello from agent");
  });
