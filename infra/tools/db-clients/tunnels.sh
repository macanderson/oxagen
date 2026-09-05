#!/usr/bin/env bash
# Open local ports onto the data node's databases.
#
# None of the three engines is reachable from the network: every container
# publishes to 127.0.0.1 on the instance only (modules/data-node/user-data.sh.tftpl),
# and the security group opens nothing. SSM port forwarding is the whole access
# story, so a GUI client talks to localhost and SSM carries it the rest of the way.
#
#   ./tunnels.sh up       start every forward in the background
#   ./tunnels.sh down     stop them
#   ./tunnels.sh status   what is listening, and whether the far end answers
#
# Deliberately the OLD account (578673726240), not a stale reference: this
# targets the combined data node `modules/data-node` builds — Postgres,
# ClickHouse and Neo4j together on one instance tagged Name=oxagen-data — and
# that shape has no equivalent in the new account. There, Postgres is Aurora
# Serverless v2 and ClickHouse's role is Redshift Serverless (both managed,
# neither reachable this way), and Neo4j runs on the shared app node instead
# of a dedicated data node. See docs/new-account-migration-plan.md.
#
# Requires the AWS CLI, the Session Manager plugin, and credentials for account
# 578673726240. Install the plugin with:
#   brew install --cask session-manager-plugin
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="${DATA_NODE_NAME:-oxagen-data}"
RUN_DIR="${TMPDIR:-/tmp}/oxagen-db-tunnels"

# local:remote, one per engine. The local ports are the module's own convention
# (modules/data-node/outputs.tf connection_help) plus two it does not forward:
# ClickHouse's native protocol and Neo4j Browser, which is the graph client.
FORWARDS=(
  "15432:5432:postgres"
  "18123:8123:clickhouse-http"
  "19000:9000:clickhouse-native"
  "17687:7687:neo4j-bolt"
  "17474:7474:neo4j-browser"
)

instance_id() {
  aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null
}

port_busy() { lsof -ti ":$1" >/dev/null 2>&1; }

up() {
  local id; id="$(instance_id)"
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    echo "no running instance tagged Name=${NAME} in ${REGION}." >&2
    echo "the node may be stopped — start it, or check your AWS credentials." >&2
    exit 1
  fi
  mkdir -p "$RUN_DIR"
  echo "data node: $id (${REGION})"

  for f in "${FORWARDS[@]}"; do
    IFS=: read -r local remote label <<<"$f"
    if port_busy "$local"; then
      echo "  $label: localhost:$local already in use — leaving it alone"
      continue
    fi
    nohup aws ssm start-session \
      --region "$REGION" \
      --target "$id" \
      --document-name AWS-StartPortForwardingSession \
      --parameters "{\"portNumber\":[\"$remote\"],\"localPortNumber\":[\"$local\"]}" \
      >"$RUN_DIR/$label.log" 2>&1 &
    echo $! >"$RUN_DIR/$label.pid"
    echo "  $label: localhost:$local -> $remote"
  done

  echo
  echo "give SSM a few seconds, then: $0 status"
}

down() {
  [ -d "$RUN_DIR" ] || { echo "nothing to stop."; return 0; }
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -e "$pidfile" ] || continue
    local label; label="$(basename "$pidfile" .pid)"
    local pid; pid="$(cat "$pidfile")"
    if kill "$pid" 2>/dev/null; then echo "  stopped $label ($pid)"; fi
    rm -f "$pidfile"
  done
  # SSM spawns the plugin as a child; clear any survivors bound to our ports.
  pkill -f 'session-manager-plugin' 2>/dev/null || true
}

status() {
  local rc=0
  for f in "${FORWARDS[@]}"; do
    IFS=: read -r local remote label <<<"$f"
    if port_busy "$local"; then
      printf '  %-18s localhost:%-6s listening\n' "$label" "$local"
    else
      printf '  %-18s localhost:%-6s DOWN\n' "$label" "$local"
      rc=1
    fi
  done
  # A listening socket only proves the forward started. Ask ClickHouse to answer,
  # which is the one engine that speaks over plain HTTP.
  if port_busy 18123; then
    if curl -fsS --max-time 5 "http://localhost:18123/ping" >/dev/null 2>&1; then
      echo "  clickhouse ping    ok"
    else
      echo "  clickhouse ping    no answer (tunnel up, engine not responding)"
      rc=1
    fi
  fi
  return $rc
}

case "${1:-status}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 2 ;;
esac
