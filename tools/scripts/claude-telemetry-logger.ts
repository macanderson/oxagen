import fs from "fs";
import path from "path";
import os from "os";

interface HookInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    content?: string;
  };
  tool_response?: {
    filePath?: string;
    success?: boolean;
  };
}

const TELEMETRY_LOG = path.join(
  os.homedir(),
  ".claude",
  "claude-code-telemetry.jsonl",
);

function ensureLogDir() {
  const dir = path.dirname(TELEMETRY_LOG);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function logTelemetry(hookInput: HookInput) {
  ensureLogDir();

  const entry = {
    timestamp: new Date().toISOString(),
    type: "claude_code",
    tool_name: hookInput.tool_name,
    files_modified: extractFiles(hookInput),
    command_executed: hookInput.tool_input?.command ? true : false,
  };

  try {
    fs.appendFileSync(TELEMETRY_LOG, JSON.stringify(entry) + "\n");
  } catch (error) {
    // Best-effort local telemetry log — a write failure must never disrupt the
    // user's workflow, but leave an OXAGEN_DEBUG-gated breadcrumb (house style)
    // so the drop is diagnosable when debugging the hook itself.
    if (process.env["OXAGEN_DEBUG"]) {
      process.stderr.write(
        `[claude-telemetry-logger] appendFileSync failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}

function extractFiles(input: HookInput): string[] {
  const files: string[] = [];

  if (input.tool_input?.file_path) {
    files.push(input.tool_input.file_path);
  }

  if (input.tool_response?.filePath) {
    files.push(input.tool_response.filePath);
  }

  return files;
}

// Read hook input from stdin
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(data) as HookInput;
    logTelemetry(hookInput);
  } catch {
    // Silently ignore parse errors
  }
});
