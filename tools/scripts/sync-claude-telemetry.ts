import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import readline from "readline";
import {
  ANALYTICS_URL,
  ANALYTICS_USER,
  ANALYTICS_PASSWORD,
  ANALYTICS_DATABASE,
} from "./clickhouse-analytics-config";

const TELEMETRY_LOG = path.join(
  os.homedir(),
  ".claude",
  "claude-code-telemetry.jsonl",
);
const SYNCED_LOG = path.join(
  os.homedir(),
  ".claude",
  "claude-code-telemetry.synced",
);

interface TelemetryEntry {
  timestamp: string;
  type: string;
  tool_name: string;
  files_modified: string[];
  command_executed: boolean;
}

async function executeClickHouseSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(ANALYTICS_URL);
    url.pathname = "/";
    url.searchParams.set("query", sql);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${ANALYTICS_USER}:${ANALYTICS_PASSWORD}`).toString("base64")}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(data);
        } else {
          reject(new Error(`ClickHouse error (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function syncTelemetry() {
  if (!fs.existsSync(TELEMETRY_LOG)) {
    return;
  }

  // Skip sync if credentials are not configured — say so instead of failing
  // silently, since a silent skip here is indistinguishable from success.
  if (!ANALYTICS_URL || !ANALYTICS_USER || !ANALYTICS_PASSWORD) {
    console.error(
      "Telemetry sync skipped: analytics URL/credentials not configured or unparseable.",
    );
    return;
  }

  const lastSyncedLine = fs.existsSync(SYNCED_LOG)
    ? parseInt(fs.readFileSync(SYNCED_LOG, "utf-8").trim(), 10)
    : 0;

  const fileStream = fs.createReadStream(TELEMETRY_LOG);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  const entries: TelemetryEntry[] = [];

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= lastSyncedLine || !line.trim()) continue;

    try {
      const entry = JSON.parse(line) as TelemetryEntry;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length === 0) return;

  // Insert into ClickHouse
  for (const entry of entries) {
    // Format array for ClickHouse: escape single quotes in file paths.
    // A hook can write a line with no `files_modified` at all, so treat a
    // missing/non-array value as empty rather than throwing out of the loop and
    // aborting the whole sync on one malformed entry.
    const files = Array.isArray(entry.files_modified)
      ? entry.files_modified
      : [];
    const filesArray = files
      .map((f) => `'${String(f).replace(/'/g, "''")}'`)
      .join(",");
    const insertSql = `
      INSERT INTO ${ANALYTICS_DATABASE}.agent_executions (
        type,
        user_email,
        model,
        files_modified,
        duration_ms,
        status
      ) VALUES (
        'claude_code',
        '${os.userInfo().username || "unknown"}@${os.hostname()}',
        'unknown',
        [${filesArray}],
        0,
        'logged'
      )
    `;

    try {
      await executeClickHouseSql(insertSql);
    } catch (error) {
      console.error(
        "Failed to sync telemetry to ClickHouse:",
        error instanceof Error ? error.message : error,
      );
      return; // Stop syncing on error
    }
  }

  // Update synced line count
  fs.writeFileSync(SYNCED_LOG, lineNumber.toString());
}

syncTelemetry()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "Telemetry sync error:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
