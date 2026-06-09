# Claude Code Telemetry System

This setup provides comprehensive tracking of Claude Code usage to your ClickHouse production instance.

## Components

### 1. ClickHouse Database & Table
- **Database:** `internal` (created in production ClickHouse)
- **Table:** `agent_executions`
- **Location:** `https://xao3dt0f2y.us-east-1.aws.clickhouse.cloud:8443`

### 2. Claude Code Hook
- **File:** `claude-telemetry-logger.ts`
- **Location:** `.claude/settings.json` → `hooks.PostToolUse`
- **Trigger:** After Write, Edit, or Bash tool execution
- **Action:** Logs telemetry events to `~/.claude/claude-code-telemetry.jsonl`

### 3. Local Telemetry Log
- **File:** `~/.claude/claude-code-telemetry.jsonl` (JSONL format)
- **Purpose:** Captures all Claude Code tool usage locally
- **Format:** One JSON object per line with timestamp, tool name, files modified, etc.

### 4. Sync Scheduler
- **File:** `sync-claude-telemetry.ts`
- **Schedule:** Every hour at :07 (cron: `7 * * * *`)
- **Job ID:** `0a4d0be4`
- **Action:** Reads unsynced telemetry and writes to ClickHouse

## Data Flow

```
Claude Code
    ↓
PostToolUse Hook (on Write|Edit|Bash)
    ↓
claude-telemetry-logger.ts
    ↓
~/.claude/claude-code-telemetry.jsonl (local log)
    ↓
Hourly Cron Job (every hour at :07)
    ↓
sync-claude-telemetry.ts
    ↓
ClickHouse internal.agent_executions table
```

## Captured Data

Each telemetry entry includes:
- `timestamp`: ISO 8601 timestamp
- `type`: Always "claude_code"
- `tool_name`: The tool executed (Write, Edit, Bash, etc.)
- `files_modified`: Array of file paths that were modified
- `command_executed`: Boolean indicating if a command was executed

Additional fields in ClickHouse:
- `user_email`: System user@hostname
- `model`: Populated as "unknown" (requires deeper integration for actual model)
- `duration_ms`: 0 (requires deeper integration)
- `status`: "logged"

## Limitations & Future Improvements

The current hook-based approach has these limitations:
1. **Prompts:** Not captured (hooks don't have access to conversation context)
2. **Token Usage:** Not captured (not available in hook context)
3. **Model Name:** Requires deeper integration with Claude Code runtime
4. **Token Cache Stats:** Not available via hooks

To capture prompts and token usage, you would need:
- Integration with Claude Code's logging layer
- Middleware or SDK-level instrumentation
- Access to Claude Code's internal telemetry pipeline

## Manual Sync

To manually sync telemetry to ClickHouse immediately:

```bash
npx tsx tools/scripts/sync-claude-telemetry.ts
```

## Verify ClickHouse Data

Check if data is being written:

```sql
SELECT COUNT(*) as total_events FROM internal.agent_executions;
SELECT * FROM internal.agent_executions ORDER BY timestamp DESC LIMIT 10;
```

## Troubleshooting

**Telemetry not appearing in ClickHouse:**
1. Check local log exists: `cat ~/.claude/claude-code-telemetry.jsonl`
2. Run manual sync: `npx tsx tools/scripts/sync-claude-telemetry.ts`
3. Verify ClickHouse credentials in `sync-claude-telemetry.ts`

**Hook not firing:**
1. Verify settings loaded: `cat ~/.claude/settings.json | grep hooks`
2. Restart Claude Code or run `/hooks` command
3. Execute a Write/Edit/Bash command and check `~/.claude/claude-code-telemetry.jsonl`

**Sync job not running:**
1. Check job status: `cat .claude/scheduled_tasks.json`
2. Verify cron job is active: Check for job ID `0a4d0be4`
3. Run sync manually to test

## ClickHouse Table Schema

```sql
CREATE TABLE internal.agent_executions (
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
```
