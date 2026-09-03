# Database clients for the data node

A GUI over the three engines on `oxagen-data`, without opening a port to the
world.

## Why there is tooling at all

Nothing on the data node is reachable from the network. Each container
publishes to `127.0.0.1` on the instance, and the security group opens no
database port — that is two independent controls, and it is the design, not an
oversight (`modules/data-node/variables.tf`). So a desktop client cannot dial
the database directly. It talks to `localhost`, and AWS SSM carries the traffic
the rest of the way.

Passwords live in Parameter Store as `SecureString` and are never written into
Terraform state or these files' committed half — `modules/data-node/outputs.tf`
explains that choice. The generator reads them fresh each time it runs.

## Setup, once

```sh
brew install --cask dbeaver-community          # the SQL studio
brew install --cask session-manager-plugin     # asks for your password
```

The Session Manager plugin is what turns `aws ssm start-session` into a real
local socket. Without it the tunnels fail with a plugin-not-found error.

## Every session

```sh
./tunnels.sh up                 # opens five local ports
./generate-dbeaver.sh           # writes the workspace, credentials included
open -a DBeaver --args -data "$PWD/generated/dbeaver-workspace"
```

`./tunnels.sh status` tells you what is listening and asks ClickHouse to answer,
because a listening socket only proves the forward started, not that anything is
behind it. `./tunnels.sh down` closes them.

| Engine | Local | On the node | Client |
|---|---|---|---|
| Postgres | 15432 | 5432 | DBeaver |
| ClickHouse HTTP | 18123 | 8123 | DBeaver |
| ClickHouse native | 19000 | 9000 | `clickhouse-client` |
| Neo4j bolt | 17687 | 7687 | Neo4j Browser, `cypher.sh` |
| Neo4j Browser | 17474 | 7474 | your web browser |

## The graph side

Neo4j ships its own query app, and the database is already serving it on 7474 —
so there is nothing to install:

```sh
./generated/open-neo4j-browser.sh
```

It prints the password, then opens Neo4j Browser. Connect to
`bolt://localhost:17687` as `neo4j`. You get the schema view, saved Cypher, and
the visual graph.

For a terminal instead:

```sh
./generated/cypher.sh 'MATCH (n) RETURN labels(n) AS label, count(*) ORDER BY 2 DESC'
```

It uses a local `cypher-shell` when there is one and falls back to the Neo4j
container image, so it works with nothing installed either.

## What you will find

Measured 2026-08-25, through the same path this tooling uses:

- **Postgres** — 27 schemas, 134 tables. The Atlas migrations are fully applied.
  Row counts are reference data only: `iam.role_grants` 2,215, `iam.roles` 10,
  and single digits elsewhere. No business data, which is what a new
  environment should look like.
- **ClickHouse** — 20 tables in `oxagen`.
- **Neo4j** — 2 nodes; labels include `EntityNode`, `GraphNode`, `Evidence`,
  `SourceConnection`, `Demotion`.

## What is generated, and what must never be committed

`generated/` is gitignored in full. It holds real passwords:
DBeaver's `credentials-config.json` is written `chmod 600`, and its encryption
uses a fixed key that ships in every DBeaver build — so treat that file as
obfuscated rather than protected. The filesystem permission is the control.

Re-run `./generate-dbeaver.sh` after any password rotation; it re-reads
Parameter Store, which stays the source of truth.

## When it does not work

- **`SessionManagerPlugin is not found`** — install the cask above.
- **DBeaver says connection refused** — the tunnels are down. Run
  `./tunnels.sh status`. This looks like a credentials problem and is not.
- **`no running instance tagged Name=oxagen-data`** — the node is stopped, or
  your shell has no AWS credentials for account 578673726240.
- **A port is already in use** — `tunnels.sh` leaves it alone and says so,
  rather than fighting whatever owns it.
