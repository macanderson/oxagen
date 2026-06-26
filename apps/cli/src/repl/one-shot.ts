/**
 * One-shot mode — run a single prompt through the local agent loop, stream the
 * response to stdout, exit.
 *
 * Usage:
 *   oxagen "fix the login bug"
 *   echo "explain this code" | oxagen
 *
 * The agent operates on the current working directory using local coding tools
 * (read/write/edit/grep/glob/bash). Model calls go through the Vercel AI Gateway.
 */
import { runAgent, MissingGatewayKeyError } from "../agent/loop.js";

export async function runOneShot(prompt: string): Promise<void> {
  try {
    let streamed = false;
    await runAgent({
      prompt,
      onText: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
      // Tool activity goes to stderr so stdout stays the clean final answer
      // (pipeable). e.g. `oxagen "..." > out.md` captures only the answer.
      onToolCall: (name, input) => {
        const summary =
          typeof input === "object" && input !== null
            ? JSON.stringify(input).slice(0, 120)
            : String(input);
        process.stderr.write(`  · ${name} ${summary}\n`);
      },
    });
    if (streamed) process.stdout.write("\n");
  } catch (err) {
    if (err instanceof MissingGatewayKeyError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exitCode = 1;
  }
}

export async function runFromStdin(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const prompt = Buffer.concat(chunks).toString("utf8").trim();
  if (!prompt) {
    process.stderr.write("Error: No input received on stdin.\n");
    process.exitCode = 1;
    return;
  }
  await runOneShot(prompt);
}
