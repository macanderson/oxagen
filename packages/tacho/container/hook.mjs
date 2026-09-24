import { request } from "node:http";
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 8 * 1024 * 1024) throw new Error("Hook payload too large");
  chunks.push(chunk);
}
const payload = Buffer.concat(chunks);
const answer = await new Promise((resolve) => {
  const call = request(
    {
      socketPath: "/opt/oxagen/session/bridge.sock",
      path: "/hook",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
      },
      timeout: 25_000,
    },
    (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () =>
        resolve(
          response.statusCode === 200
            ? Buffer.concat(body).toString("utf8")
            : undefined,
        ),
      );
    },
  );
  call.on("timeout", () => call.destroy());
  call.on("error", () => resolve(undefined));
  call.end(payload);
});
if (answer === undefined) {
  process.stdout.write(
    JSON.stringify({
      continue: false,
      stopReason: "Oxagen containment gateway is unavailable",
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "Oxagen containment gateway is unavailable",
      },
    }),
  );
  process.exitCode = 2;
} else {
  const parsed = JSON.parse(answer);
  if (parsed.hookSpecificOutput?.permissionDecision === "ask") {
    parsed.hookSpecificOutput.permissionDecision = "deny";
    parsed.hookSpecificOutput.permissionDecisionReason =
      "Approve this request in Oxagen before retrying";
  }
  process.stdout.write(JSON.stringify(parsed));
}
