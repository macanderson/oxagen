#!/usr/bin/env bash
# Write a ready-to-open DBeaver workspace for the data node's Postgres and
# ClickHouse, plus a Neo4j Browser launcher.
#
# Passwords are read from Parameter Store at generation time and written into
# DBeaver's own credentials store. They are NEVER committed: everything lands in
# ./generated, which .gitignore excludes, and the credentials file is chmod 600.
# Re-run this whenever a password rotates.
#
#   ./generate-dbeaver.sh
#   open -a DBeaver --args -data "$(pwd)/generated/dbeaver-workspace"
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="${DATA_NODE_NAME:-oxagen-data}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/generated"
WS="$OUT/dbeaver-workspace"
PROJ="$WS/General"
CFG="$PROJ/.dbeaver"

# DBeaver encrypts credentials-config.json with a fixed AES-128-CBC key, a zero
# IV, and 16 bytes of leading filler that the reader discards. The key is not a
# secret — it ships in every DBeaver build — so this file is obfuscated, not
# protected. That is why it is chmod 600 and gitignored: the filesystem is the
# only thing actually guarding it.
DBEAVER_KEY="babb4a9f774ab853c96c2d653dfe544a"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }; }
need aws; need openssl; need python3

param() {
  aws ssm get-parameter --region "$REGION" --name "/$NAME/$1/password" \
    --with-decryption --query Parameter.Value --output text 2>/dev/null
}

echo "reading credentials from Parameter Store (/$NAME/*/password)..."
PG_PW="$(param postgres)"
CH_PW="$(param clickhouse)"
NEO_PW="$(param neo4j)"
for pair in "postgres:$PG_PW" "clickhouse:$CH_PW" "neo4j:$NEO_PW"; do
  [ -n "${pair#*:}" ] || { echo "could not read /$NAME/${pair%%:*}/password" >&2; exit 1; }
done

mkdir -p "$CFG"

# ── connections ──────────────────────────────────────────────────────────────
# Both point at localhost: the engines are only reachable through the SSM
# forwards that tunnels.sh opens. Start those first or DBeaver reports a refused
# connection, which looks like a credentials problem and is not.
cat >"$CFG/data-sources.json" <<'JSON'
{
  "folders": {},
  "connections": {
    "oxagen-postgres": {
      "provider": "postgresql",
      "driver": "postgres-jdbc",
      "name": "Oxagen · Postgres (SSM tunnel)",
      "save-password": true,
      "read-only": false,
      "configuration": {
        "host": "localhost",
        "port": "15432",
        "database": "oxagen",
        "url": "jdbc:postgresql://localhost:15432/oxagen",
        "type": "dev",
        "auth-model": "native",
        "provider-properties": {
          "@dbeaver-show-non-default-db@": "true",
          "@dbeaver-show-template-db@": "false"
        }
      }
    },
    "oxagen-clickhouse": {
      "provider": "clickhouse",
      "driver": "com_clickhouse",
      "name": "Oxagen · ClickHouse (SSM tunnel)",
      "save-password": true,
      "read-only": false,
      "configuration": {
        "host": "localhost",
        "port": "18123",
        "database": "oxagen",
        "url": "jdbc:clickhouse://localhost:18123/oxagen",
        "type": "dev",
        "auth-model": "native"
      }
    }
  }
}
JSON

# ── credentials ──────────────────────────────────────────────────────────────
python3 - "$PG_PW" "$CH_PW" >"$OUT/.creds.json" <<'PY'
import json, sys
pg, ch = sys.argv[1], sys.argv[2]
print(json.dumps({
    "oxagen-postgres":  {"#connection": {"user": "oxagen", "password": pg}},
    "oxagen-clickhouse": {"#connection": {"user": "oxagen", "password": ch}},
}))
PY

# 16 bytes of filler, then the JSON, then AES-128-CBC with a zero IV.
{ head -c 16 /dev/zero; cat "$OUT/.creds.json"; } \
  | openssl enc -aes-128-cbc -K "$DBEAVER_KEY" -iv "$(printf '0%.0s' {1..32})" \
      -out "$CFG/credentials-config.json"
rm -f "$OUT/.creds.json"
chmod 600 "$CFG/credentials-config.json"

# A place for saved queries, so "save this query" has an obvious home.
mkdir -p "$PROJ/Scripts"
cat >"$PROJ/Scripts/00-orientation.sql" <<'SQL'
-- Orientation. Open with the Postgres connection selected.
-- Every table in the estate, by schema, biggest first.
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;

-- Row counts without a full scan (planner estimate; good enough to orient).
-- SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 40;

-- ClickHouse: switch the connection above to Oxagen · ClickHouse first.
-- SELECT database, name, engine, total_rows
-- FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema')
-- ORDER BY total_rows DESC;
SQL

# ── Neo4j ────────────────────────────────────────────────────────────────────
# No install: Neo4j Browser is served by the database itself on 7474, and
# tunnels.sh forwards it. This opens it and prints what to type in the login box.
cat >"$OUT/open-neo4j-browser.sh" <<NEO
#!/usr/bin/env bash
# Neo4j Browser, served by the database itself — nothing to install.
# Requires ../tunnels.sh up.
set -euo pipefail
if ! lsof -ti :17474 >/dev/null 2>&1; then
  echo "the Neo4j Browser tunnel is not up. run: ./tunnels.sh up" >&2
  exit 1
fi
cat <<'TXT'
Neo4j Browser is opening. In its connect form:

  Connect URL   bolt://localhost:17687
  Database      leave blank
  Username      neo4j
  Password      (printed below)

TXT
aws ssm get-parameter --region "$REGION" --name "/$NAME/neo4j/password" \\
  --with-decryption --query Parameter.Value --output text
echo
open "http://localhost:17474" 2>/dev/null || echo "open http://localhost:17474"
NEO
chmod +x "$OUT/open-neo4j-browser.sh"

# cypher-shell for anyone who would rather stay in a terminal.
cat >"$OUT/cypher.sh" <<NEO
#!/usr/bin/env bash
# One-off Cypher against the tunnelled bolt port. Requires ../tunnels.sh up.
#   ./cypher.sh 'MATCH (n) RETURN labels(n) AS label, count(*) ORDER BY 2 DESC'
set -euo pipefail
PW="\$(aws ssm get-parameter --region "$REGION" --name "/$NAME/neo4j/password" \\
  --with-decryption --query Parameter.Value --output text)"
if command -v cypher-shell >/dev/null 2>&1; then
  exec cypher-shell -a bolt://localhost:17687 -u neo4j -p "\$PW" "\$@"
fi
exec docker run --rm -i --network host neo4j:5.24-community \\
  cypher-shell -a bolt://localhost:17687 -u neo4j -p "\$PW" "\$@"
NEO
chmod +x "$OUT/cypher.sh"

echo
echo "wrote:"
echo "  $WS                      DBeaver workspace (Postgres + ClickHouse, credentials saved)"
echo "  $OUT/open-neo4j-browser.sh   Neo4j Browser, no install"
echo "  $OUT/cypher.sh               cypher-shell one-liners"
echo
echo "next:"
echo "  ./tunnels.sh up"
echo "  open -a DBeaver --args -data \"$WS\""
