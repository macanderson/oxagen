import https from "https";
import {
  ANALYTICS_URL,
  ANALYTICS_USER,
  ANALYTICS_PASSWORD,
  ANALYTICS_DATABASE,
} from "./clickhouse-analytics-config";

function executeClickHouseSql(sql: string): Promise<string> {
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

async function setupTelemetry() {
  try {
    console.log(`Creating ${ANALYTICS_DATABASE} database...`);
    await executeClickHouseSql(
      `CREATE DATABASE IF NOT EXISTS ${ANALYTICS_DATABASE}`,
    );
    console.log("✓ Database created");

    console.log("Creating agent_executions table...");
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS ${ANALYTICS_DATABASE}.agent_executions (
        conversation_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
        execution_id UUID DEFAULT generateUUIDv4(),
        user_email String DEFAULT '',
        provider LowCardinality(String) DEFAULT '',
        model LowCardinality(String) DEFAULT '',
        input_tokens UInt64 DEFAULT 0,
        output_tokens UInt64 DEFAULT 0,
        cached_tokens UInt64 DEFAULT 0,
        cache_misses UInt64 DEFAULT 0,
        cost_usd_micros UInt64 DEFAULT 0,
        duration_ms UInt32 DEFAULT 0,
        surface LowCardinality(String) DEFAULT 'claude-code',
        prompt_hash String DEFAULT '',
        session_recap String DEFAULT '',
        recap_generated_at Nullable(DateTime64(3)),
        type String DEFAULT 'claude_code',
        files_modified String DEFAULT '[]',
        status String DEFAULT 'completed',
        created_at DateTime64(3) DEFAULT now(),
        updated_at DateTime64(3) DEFAULT now()
      ) ENGINE = ReplacingMergeTree(updated_at)
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (user_email, conversation_id, created_at)
      TTL toDateTime(created_at) + INTERVAL 365 DAY;
    `;

    await executeClickHouseSql(createTableSql);
    console.log("✓ Table created");

    console.log("\n✅ ClickHouse setup complete!");
    console.log("\nTable schema:");
    console.log("- conversation_id: UUID (session grouping)");
    console.log("- user_email: String");
    console.log(
      "- provider: LowCardinality(String) - anthropic, openai, google, etc",
    );
    console.log("- model: LowCardinality(String) - model identifier");
    console.log("- input_tokens: UInt64");
    console.log("- output_tokens: UInt64");
    console.log("- cached_tokens: UInt64 - cache hit tokens");
    console.log("- cache_misses: UInt64 - cache misses");
    console.log("- duration_ms: UInt32 - call latency");
    console.log(
      "- surface: LowCardinality(String) - claude-code, app, api, mcp",
    );
    console.log("- prompt_hash: String - SHA256 hash of prompt (PII-free)");
    console.log("- session_recap: String - LLM-powered session summary");
    console.log(
      "- recap_generated_at: DateTime64(3) - when recap was generated",
    );
  } catch (error) {
    console.error(
      "❌ Setup failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

setupTelemetry();
