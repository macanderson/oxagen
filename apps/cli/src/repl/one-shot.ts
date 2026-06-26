/**
 * One-shot mode — run a single prompt, stream the response, exit.
 *
 * Usage:
 *   oxagen "fix the login bug"
 *   echo "explain this code" | oxagen
 */
import { getApiUrl, getToken } from "../lib/config.js";

export async function runOneShot(prompt: string): Promise<void> {
  const token = getToken();
  const apiUrl = getApiUrl();

  if (!token) {
    process.stderr.write(
      "Error: No API token configured.\n" +
        "Run `oxagen config token <your-token>` or set OXAGEN_API_TOKEN.\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(`${apiUrl}/chat/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message: prompt }),
    });

    if (!response.ok) {
      process.stderr.write(
        `Error: API returned ${response.status} ${response.statusText}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const data = (await response.json()) as { content: string };
    process.stdout.write(data.content + "\n");
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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
