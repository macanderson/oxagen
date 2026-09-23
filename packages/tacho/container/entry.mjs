import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const [harness, ...input] = process.argv.slice(2);
if (!["claude-code", "codex"].includes(harness))
  throw new Error("Unsupported contained harness");
for (const path of ["home/.codex", "tmp", "state", "log"])
  mkdirSync(`/workspace/.oxagen-contained/${path}`, { recursive: true });
copyFileSync(
  "/opt/oxagen/session/config.toml",
  "/workspace/.oxagen-contained/home/.codex/config.toml",
);
const bridge = createServer((incoming, outgoing) => {
  const upstream = request(
    {
      socketPath: "/opt/oxagen/session/bridge.sock",
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
  outgoing.on("close", () => upstream.destroy());
});
bridge.on("upgrade", (_request, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  bridge.once("error", reject);
  bridge.listen(43801, "127.0.0.1", resolve);
});
const env = {
  PATH: process.env.PATH,
  HOME: "/workspace/.oxagen-contained/home",
  TMPDIR: "/workspace/.oxagen-contained/tmp",
  CODEX_HOME: "/workspace/.oxagen-contained/home/.codex",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:43801/model",
  ANTHROPIC_API_KEY: "contained-route",
  OXAGEN_CONTAINED_ROUTE: "contained-route",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
// GitHub is reachable only through the bridge, for the one repository the
// launcher named (ADR-152). The token stays outside; git and the REST API see
// a loopback URL that the bridge rewrites and authenticates.
const github = "/opt/oxagen/session/github.json";
if (existsSync(github)) {
  const { repository } = JSON.parse(readFileSync(github, "utf8"));
  Object.assign(env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "url.http://127.0.0.1:43801/github/git/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: "safe.directory",
    GIT_CONFIG_VALUE_1: "/workspace",
    GITHUB_API_URL: "http://127.0.0.1:43801/github/api",
    GITHUB_REPOSITORY: repository,
  });
}
const args =
  harness === "codex"
    ? ["exec", "--ephemeral", ...(input[0] === "exec" ? input.slice(1) : input)]
    : ["--print", ...input];
const child = spawn(harness === "codex" ? "codex" : "claude", args, {
  cwd: "/workspace",
  env,
  stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve) => {
  child.on("error", () => resolve(1));
  child.on("close", (value) => resolve(value ?? 1));
});
bridge.closeAllConnections();
bridge.close();
process.exitCode = code;
