# Seeds a throwaway ClickHouse for run.transcript.get.bench.test.ts: one
# 250,000-frame wrapped run (240,000 root frames plus ten subagent chains of
# 1,000) and forty 25,000-frame runs as workspace noise. The first of those
# forty is the benchmark's 25k run.
#
# Never point this at a shared store: it truncates tacho_events.
#
#   docker run -d --rm --name bench-ch --memory 1536m -p 127.0.0.1:18123:8123 \
#     -e CLICKHOUSE_DB=bench -e CLICKHOUSE_USER=bench -e CLICKHOUSE_PASSWORD=bench \
#     -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:24.8-alpine
#   docker exec -i bench-ch clickhouse-client -u bench --password bench -d bench \
#     --multiquery < packages/telemetry/src/migrations/0027_tacho_events.sql
#   python3 packages/handlers/bench/seed-tacho-run.py
import os, urllib.request, base64, sys, time
URL = os.environ.get("BENCH_CLICKHOUSE_URL", "http://127.0.0.1:18123") + "/?database=bench&max_threads=1&max_insert_threads=1"
AUTH = "Basic " + base64.b64encode(b"bench:bench").decode()
ORG = "0b0e0000-0000-4000-8000-000000000001"
WS = "0b0e0000-0000-4000-8000-000000000002"
ROOT = "0b0e0000-0000-4000-8000-0000000000aa"
def run(sql):
    req = urllib.request.Request(URL, data=sql.encode(), headers={"Authorization": AUTH})
    try: return urllib.request.urlopen(req, timeout=600).read().decode()
    except urllib.error.HTTPError as e: sys.exit("ERR " + e.read().decode()[:500])

COLS = """org_id, workspace_id, session_uuid, root_session_uuid, parent_session_uuid,
 subagent_id, subagent_type, spawn_tool_use_id, spawn_depth, seq, ts, event_id, event_id_idem,
 kind, prev_hash, hash, content_digest, bytes_ref, body, source, fidelity, attrs, tool_name,
 tool_status, tool_use_id, model, provider, cost_usd_micros, turn_seq, received_at"""

def frames(session, root, parent, n, sub_id="", spawn="", depth=0, spawns=None):
    for start in range(0, n, 5_000):
        run(one(session, root, parent, start, min(5_000, n - start), sub_id, spawn, depth, spawns))

def one(session, root, parent, start, count, sub_id, spawn, depth, spawns):
    # 62 frames a turn: turn_start, 20 x (llm_call, tool_requested, tool_call), turn_end.
    # `spawns`: turn numbers whose first tool_requested is a subagent_start instead.
    spawn_expr = "0"
    if spawns:
        spawn_expr = "(intDiv(number, 62) IN (" + ",".join(str(t) for t in spawns) + ") AND number % 62 = 2)"
    kind = f"""multiIf(number % 62 = 0, 'turn_start', number % 62 = 61, 'turn_end',
      {spawn_expr}, 'subagent_start',
      (number % 62 - 1) % 3 = 0, 'llm_call', (number % 62 - 1) % 3 = 1, 'tool_requested', 'tool_call')"""
    return f"""INSERT INTO tacho_events ({COLS})
SELECT '{ORG}', '{WS}', '{session}', '{root}', {parent},
  '{sub_id}', {"'general-purpose'" if sub_id else "''"}, '{spawn}', {depth},
  number, toDateTime64('2026-09-20 09:00:00', 6) + number * 0.25,
  toString(generateUUIDv4()), hex(sipHash128('{session}', number)),
  {kind} AS k, hex(sipHash128('{session}', number - 1)), hex(sipHash128('{session}', number)),
  '', '', '{{}}', 'hook', 'hook',
  if(k = 'subagent_start', map('hook.agent_id', concat('agent_', toString(intDiv(number, 62)))), map()),
  if(k IN ('tool_requested', 'tool_call'), 'Bash', ''),
  if(k = 'tool_call', 'ok', ''),
  multiIf(k = 'subagent_start', concat('toolu_sub_', toString(intDiv(number, 62))),
          k = 'tool_requested', concat('toolu_', toString(number)),
          k = 'tool_call', concat('toolu_', toString(number - 1)), ''),
  if(k = 'llm_call', 'claude-opus-5-5', ''), if(k = 'llm_call', 'anthropic', ''),
  if(k = 'llm_call', toNullable(toUInt64(1500)), NULL), toUInt32(intDiv(number, 62)), now64(6)
FROM numbers({start}, {count})"""

run("TRUNCATE TABLE tacho_events")
run("ALTER TABLE tacho_events MODIFY SETTING min_bytes_for_wide_part = 100000000000, min_rows_for_wide_part = 1000000000")
run("SYSTEM STOP MERGES tacho_events")
t = time.time()
spawn_turns = [100 + 400 * i for i in range(10)]
frames(ROOT, ROOT, "NULL", 240_000, spawns=spawn_turns)
for i, turn in enumerate(spawn_turns):
    child = f"0b0e0000-0000-4000-8000-0000000001{i:02d}"
    frames(child, ROOT, f"'{ROOT}'", 1_000, sub_id=f"agent_{turn}", spawn=f"toolu_sub_{turn}", depth=1)
for i in range(40):
    other = f"0b0e0000-0000-4000-8000-0000000002{i:02d}"
    frames(other, other, "NULL", 25_000)
run("ALTER TABLE tacho_events MODIFY SETTING min_bytes_for_wide_part = 10485760, min_rows_for_wide_part = 0")
run("SYSTEM START MERGES tacho_events")
run("OPTIMIZE TABLE tacho_events FINAL")
print("seeded in %.1fs" % (time.time() - t))
print(run(f"SELECT uniqExact(session_uuid), count(), countIf(root_session_uuid = '{ROOT}') FROM tacho_events FORMAT TSV"))
print(run("SELECT count() FROM system.parts WHERE database='bench' AND table='tacho_events' AND active FORMAT TSV"))
