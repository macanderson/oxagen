#!/usr/bin/env bash
#
# How a CI runner reaches production ClickHouse, decided from the
# CLICKHOUSE_URL that Parameter Store holds (#5395, ADR-295).
#
# A runner reaches ClickHouse only through the app node, over an SSM port
# forward. The URL says which of two places ClickHouse is:
#
#   http://127.0.0.1:8123   ClickHouse in a container on the node. The runner
#                           forwards the node's port 8123 to its own loopback.
#                           This is the shape CI has always handled, and the
#                           answer for it is unchanged.
#
#   https://<host>:8443     ClickHouse Cloud. Cloud admits one address, the
#                           node's NAT address, and a GitHub runner has no fixed
#                           address to admit. So the runner forwards a local
#                           port through the node to the Cloud host, and the
#                           connection leaves AWS from the NAT address. The URL
#                           the runner uses keeps the Cloud host name, so TLS
#                           checks the certificate against the real name. The
#                           caller maps that name to 127.0.0.1 in /etc/hosts,
#                           the way the Aurora coordinator tunnel does.
#
# Usage, sourced or run:
#
#   clickhouse_tunnel URL LOCAL_PORT
#
# It prints four lines and returns 0:
#
#   mode=node or mode=remote
#   host=<the Cloud host name, empty for node>
#   port=<the port on the far side of the tunnel>
#   url=<the CLICKHOUSE_URL the runner uses>
#
# For any other URL it names the problem on stderr and returns 1. The URL can
# carry a credential, so no message here repeats it.
#
# For https only the port changes. The user info, the path, and the query
# survive, because the ClickHouse client reads the path as the database and
# the query as settings. A URL without a port means 443, the port the client
# itself would use.

# clickhouse_tunnel URL LOCAL_PORT
clickhouse_tunnel() {
  local url=$1 local_port=$2

  if [[ ! $local_port =~ ^[0-9]{1,5}$ ]] || ((10#$local_port < 1 || 10#$local_port > 65535)); then
    echo "clickhouse_tunnel: the local port must be a number from 1 to 65535" >&2
    return 1
  fi

  case "$url" in
    http://*)
      # The node's own ClickHouse. Whatever host and port the URL names, the
      # node serves ClickHouse on 8123, and the runner reaches it on loopback.
      printf 'mode=node\nhost=\nport=8123\nurl=http://127.0.0.1:%s/\n' "$local_port"
      return 0
      ;;
    https://*) ;;
    *)
      echo "clickhouse_tunnel: CLICKHOUSE_URL must start with http:// (the node) or https:// (ClickHouse Cloud)" >&2
      return 1
      ;;
  esac

  local rest=${url#https://}
  local authority=${rest%%[/?#]*}
  local suffix=${rest#"$authority"}
  local userinfo="" hostport=$authority
  if [[ $authority == *@* ]]; then
    userinfo="${authority%@*}@"
    hostport=${authority##*@}
  fi

  local host=${hostport%%:*} port=443
  if [[ $hostport == *:* ]]; then
    port=${hostport#*:}
  fi

  # A DNS name with at least one dot, whose last label starts with a letter.
  # An IP address cannot carry the certificate's name, and /etc/hosts maps
  # names, so an address is refused.
  local label='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?'
  if [[ ! $host =~ ^($label\.)+[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
    echo "clickhouse_tunnel: an https CLICKHOUSE_URL must name its host by a DNS name, so TLS can check the certificate" >&2
    return 1
  fi
  if [[ ! $port =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
    echo "clickhouse_tunnel: the port in the https CLICKHOUSE_URL must be a number from 1 to 65535" >&2
    return 1
  fi

  printf 'mode=remote\nhost=%s\nport=%s\nurl=https://%s%s:%s%s\n' \
    "$host" "$port" "$userinfo" "$host" "$local_port" "${suffix:-/}"
}

# Sourcing stops here.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "usage: clickhouse-tunnel.sh CLICKHOUSE_URL LOCAL_PORT" >&2
  exit 2
fi
clickhouse_tunnel "$1" "$2"
