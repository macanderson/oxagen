import https from 'https';
import { ANALYTICS_URL, ANALYTICS_USER, ANALYTICS_PASSWORD, ANALYTICS_DATABASE } from './clickhouse-analytics-config';

function executeClickHouseSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(ANALYTICS_URL);
    url.pathname = '/';
    url.searchParams.set('query', sql);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${ANALYTICS_USER}:${ANALYTICS_PASSWORD}`).toString('base64')}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(data);
        } else {
          reject(new Error(`ClickHouse error (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function setupTelemetry() {
  try {
    console.log(`Creating ${ANALYTICS_DATABASE} database...`);
    await executeClickHouseSql(`CREATE DATABASE IF NOT EXISTS ${ANALYTICS_DATABASE}`);
    console.log('✓ Database created');

    console.log('Creating agent_executions table...');
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS ${ANALYTICS_DATABASE}.agent_executions (
        timestamp DateTime DEFAULT now(),
        type String,
        user_email String,
        session_id String,
        model String,
        prompt String,
        tokens_in UInt32,
        tokens_out UInt32,
        cache_tokens_read UInt32 DEFAULT 0,
        cache_tokens_created UInt32 DEFAULT 0,
        files_modified Array(String),
        duration_ms UInt32,
        status String DEFAULT 'success'
      ) ENGINE = MergeTree()
      ORDER BY (timestamp, type)
      TTL timestamp + INTERVAL 1 YEAR DELETE;
    `;

    await executeClickHouseSql(createTableSql);
    console.log('✓ Table created');

    console.log('\n✅ ClickHouse setup complete!');
    console.log('\nTable schema:');
    console.log('- timestamp: DateTime (auto-populated with current time)');
    console.log('- type: String (populated with "claude_code")');
    console.log('- user_email: String');
    console.log('- session_id: String');
    console.log('- model: String (e.g., claude-haiku-4-5)');
    console.log('- prompt: String');
    console.log('- tokens_in: UInt32');
    console.log('- tokens_out: UInt32');
    console.log('- cache_tokens_read: UInt32');
    console.log('- cache_tokens_created: UInt32');
    console.log('- files_modified: Array(String)');
    console.log('- duration_ms: UInt32');
    console.log('- status: String');

  } catch (error) {
    console.error('❌ Setup failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

setupTelemetry();
