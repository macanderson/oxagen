# Oxagen relay

You have servers and APIs on a private network, and Oxagen's gateway needs to call them. Run the relay inside that network. It opens one outbound TLS connection to Oxagen and sends only the requests the gateway signed. You open no inbound port.

## How the relay decides

The relay dials the broker at `RELAY_BROKER_URL`, presents `RELAY_TOKEN`, and holds the connection with a heartbeat every 20 seconds. The broker sends each call as a signed `relay-envelope/v1`. The relay sends the call only when every check below passes. It refuses the call and sends nothing when:

| Code | What the relay found |
|---|---|
| `unsigned` | The envelope has no signature. |
| `invalid` | The envelope is not a valid `relay-envelope/v1`, or a header cannot be sent. |
| `untrusted_key` | A key that `RELAY_TRUSTED_KEYS` does not hold signed the envelope. |
| `bad_signature` | The signature does not match the envelope. |
| `wrong_relay` | The envelope names another relay. |
| `wrong_workspace` | The envelope names another workspace. |
| `not_yet_valid` | The envelope's issue time is later than the relay's clock allows. |
| `expired` | The envelope expired, or was issued before this relay process could track it. |
| `replayed` | The relay already accepted an envelope with this nonce. |
| `headers_mismatch` | The request's headers differ from the signed hash. |
| `body_mismatch` | The request's body differs from the signed hash. |
| `host_not_allowed` | `RELAY_ALLOWED_HOSTS` does not name the target host and port. |
| `credential_missing` | The envelope names a credential the relay's environment does not hold. |
| `busy` | The relay holds 256 calls, or tracks as many nonces as it can. |

An accepted call goes to exactly the method, host, and path the envelope names, or the gRPC service and method. An envelope expires at most 30 seconds after Oxagen issues it.

While the relay has no connection to the broker, it sends nothing. It drops every open call when the connection closes. It then dials again after 1 second, doubling the wait on each failure up to 30 seconds.

The relay carries HTTP/1.1, MCP streamable HTTP, and gRPC over HTTP/2. It stops a response that grows past `RELAY_MAX_RESPONSE_BYTES` and reports the call as failed.

## Build the image

Oxagen publishes no relay image yet. Build one from the repository root and push it to a registry your cluster can pull from. The tag below is the relay's version:

```sh
TAG=$(node -p "require('./apps/relay/package.json').version")
docker build -f apps/relay/Dockerfile -t <your-registry>/oxagen-relay:$TAG .
docker push <your-registry>/oxagen-relay:$TAG
```

The image holds Node 24 and one bundled file, `/opt/oxagen-relay/relay.cjs`. It runs as user 1000 and exposes no port.

## Run with Docker

```sh
docker run --rm \
  -e RELAY_BROKER_URL=wss://mcp.oxagen.sh \
  -e RELAY_TOKEN \
  -e RELAY_NAME=billing \
  -e RELAY_WORKSPACE=wrk_0123456789abcdefghijkl \
  -e RELAY_TRUSTED_KEYS="$(cat oxagen-relay-signing.pem)" \
  -e RELAY_ALLOWED_HOSTS=billing.internal,ledger.internal:50051 \
  <your-registry>/oxagen-relay:$TAG
```

`-e RELAY_TOKEN` with no value copies the token from your shell environment, so it stays out of your shell history.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `RELAY_BROKER_URL` | Yes | The broker's `wss://` address. A URL with no path gets `/relay/v1/connect`. |
| `RELAY_TOKEN` | Yes | The relay token. It holds no spaces or line breaks. |
| `RELAY_NAME` | Yes | The relay's name in Oxagen: up to 63 lowercase letters, digits, and hyphens. |
| `RELAY_WORKSPACE` | Yes | The workspace id, `wrk_` and 22 characters. |
| `RELAY_TRUSTED_KEYS` | Yes | One or more PEM public keys. A value with `\n` escapes on one line also works. |
| `RELAY_ALLOWED_HOSTS` | Yes | Hosts the relay may call, separated by commas or spaces. |
| `RELAY_CLOCK_SKEW_MS` | No | How far the relay's clock may differ from Oxagen's, from 0 to 60000. The default is 5000. |
| `RELAY_MAX_RESPONSE_BYTES` | No | The largest response the relay returns, from 1024 to 268435456. The default is 8388608 (8 MiB). |
| `RELAY_CREDENTIAL_*` | No | Customer-held credentials. See Credentials. |

An entry in `RELAY_ALLOWED_HOSTS` is a host name or an IPv4 address, with an optional port. A bare host allows only the scheme's default port: 443 for `https` and 80 for `http`. Write `host:port` for any other port. The relay takes no scheme, path, or wildcard.

The relay checks every variable when it starts. If one is wrong, it writes every problem to standard error and exits with code 2.

## Install with Helm

```sh
helm install billing-relay apps/relay/chart \
  --namespace oxagen-relay --create-namespace \
  --set image.repository=<your-registry>/oxagen-relay \
  --set image.tag=$TAG \
  --set relay.brokerUrl=wss://mcp.oxagen.sh \
  --set relay.name=billing \
  --set relay.workspace=wrk_0123456789abcdefghijkl \
  --set-file relay.trustedKeys=oxagen-relay-signing.pem \
  --set 'relay.allowedHosts={billing.internal,ledger.internal:50051}' \
  --set token.existingSecret=billing-relay-token
```

Create the token Secret first, so the token never sits in a values file:

```sh
kubectl create secret generic billing-relay-token \
  --namespace oxagen-relay --from-literal=RELAY_TOKEN="$RELAY_TOKEN"
```

The chart refuses to render when a required value is missing, and its message names the value.

### Chart values

| Value | Default | Meaning |
|---|---|---|
| `image.repository` | none | The image you built. Required. |
| `image.tag` | none | The tag you pushed. Required. |
| `image.pullPolicy` | `IfNotPresent` | The pull policy. |
| `imagePullSecrets` | `[]` | Secrets for a private registry. |
| `replicaCount` | `1` | Relay pods. Two or more keep calls flowing through a restart. |
| `relay.brokerUrl` | none | `RELAY_BROKER_URL`. Required. |
| `relay.name` | none | `RELAY_NAME`. Required. |
| `relay.workspace` | none | `RELAY_WORKSPACE`. Required. |
| `relay.trustedKeys` | none | `RELAY_TRUSTED_KEYS`, the PEM text. Required. |
| `relay.allowedHosts` | `[]` | `RELAY_ALLOWED_HOSTS`, as a list. Required. |
| `relay.clockSkewMs` | `5000` | `RELAY_CLOCK_SKEW_MS`. |
| `relay.maxResponseBytes` | `8388608` | `RELAY_MAX_RESPONSE_BYTES`. |
| `token.value` | `""` | The token. The chart stores it in its own Secret. |
| `token.existingSecret` | `""` | A Secret you manage that holds the token. Set this or `token.value`. |
| `token.existingSecretKey` | `RELAY_TOKEN` | The key in that Secret. |
| `credentials.existingSecret` | `""` | A Secret whose keys are `RELAY_CREDENTIAL_*` variables. |
| `extraCaCerts.configMap` | `""` | A ConfigMap holding extra CA certificates. |
| `extraCaCerts.key` | `ca.crt` | The key in that ConfigMap. |
| `serviceAccount.create` | `true` | Create a service account with no API token mounted. |
| `serviceAccount.name` | `""` | The service account's name. |
| `serviceAccount.annotations` | `{}` | Annotations on the service account. |
| `podAnnotations` | `{}` | Annotations on each pod. |
| `podLabels` | `{}` | Labels on each pod. |
| `resources` | 50m CPU and 128Mi requested, 512Mi limit | Raise the memory limit with `relay.maxResponseBytes`. |
| `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints` | empty | Pod scheduling. |
| `networkPolicy.enabled` | `false` | Add a NetworkPolicy that refuses all inbound traffic. |
| `networkPolicy.egress` | `[]` | The egress rules for that policy. |

The pod runs as user 1000 with a read-only root filesystem, no privilege escalation, every capability dropped, and the `RuntimeDefault` seccomp profile. It has no ports, no Service, and no probes.

## Where to run the relay

- Run it in the network segment that already reaches the servers it calls. It calls the hosts in `RELAY_ALLOWED_HOSTS` and nothing else.
- Allow outbound TLS on port 443 to the broker's host, and DNS. The relay needs no inbound port.
- Run two replicas. The broker spreads calls across every connected replica of a relay, so a restart or a node drain leaves the other one serving.
- Turn on `networkPolicy.enabled` and list the broker and each allowed host under `networkPolicy.egress`. A NetworkPolicy matches addresses, not host names, so write the CIDR blocks those names resolve to.
- Keep the node's clock synced with NTP. When it drifts more than `RELAY_CLOCK_SKEW_MS` from Oxagen's, the relay refuses every envelope as `expired` or `not_yet_valid`.

## Credentials

An envelope may name a credential, which the relay adds from its own environment. The secret never leaves your network, and Oxagen never sees it. Oxagen lets an envelope name a credential only on the Enterprise plan.

For a credential named `billing-api`, the relay reads:

| Scheme | Variables |
|---|---|
| `bearer` | `RELAY_CREDENTIAL_BILLING_API_TOKEN` |
| `basic` | `RELAY_CREDENTIAL_BILLING_API_USERNAME` and `RELAY_CREDENTIAL_BILLING_API_PASSWORD` |
| `header` | `RELAY_CREDENTIAL_BILLING_API_VALUE`, sent in the header the envelope names |
| `mutual_tls` | `RELAY_CREDENTIAL_BILLING_API_CERT` and `RELAY_CREDENTIAL_BILLING_API_KEY` |

A bearer, basic, or header credential replaces any header of the same name. A token or header value for an HTTP call may hold tab, printable ASCII, and the characters from U+0080 to U+00FF. For a gRPC call it may hold printable ASCII only. A basic user name may not hold a colon. The relay refuses a value that breaks these rules with `credential_missing`, and its message names the variable without quoting the value.

A `mutual_tls` credential adds no header. The relay presents the client certificate in the TLS handshake with the upstream, so Oxagen names one only for an `https` target. `_CERT` holds the certificate and `_KEY` its unencrypted private key, both as PEM text. A PEM written on one line, with each line break as `\n`, works too. The relay refuses a certificate that does not parse, a key that does not parse, or a key that does not match the certificate with `credential_missing`, and its message names the variable without quoting the value.

With Helm, put the variables in a Secret and set `credentials.existingSecret` to its name.

## Private certificate authorities

The relay trusts Node's built-in certificate authorities. When your servers use a private one, put its certificate in a ConfigMap and set `extraCaCerts.configMap`. The chart mounts it and sets `NODE_EXTRA_CA_CERTS`. With Docker, mount the file and set `NODE_EXTRA_CA_CERTS` to its path.

## Revoked tokens

When Oxagen revokes a relay token, the broker refuses the next connect with 401. A relay that is already connected stops within 30 seconds. The broker checks each live connection's token every 30 seconds and closes the connection with WebSocket code 4001 once the token no longer checks. The relay then logs `"event":"token_revoked"` and keeps dialing, and the broker answers each dial with 401.

To bring the relay back, create a new relay token, set `RELAY_TOKEN` to it, and restart the relay.

## Start and stop

The relay waits twice `RELAY_CLOCK_SKEW_MS` after it starts before its first dial. It cannot tell an envelope issued before it started from a replay, so it refuses those, and the wait keeps it from taking calls it would refuse. With the default skew, the wait is 10 seconds.

The relay logs one JSON object per line on standard output. A log line holds no header, body, token, or credential, and a path loses its query string. `"event":"ready"` means the broker accepted the relay.

On SIGTERM or SIGINT, the relay closes its connection and exits 0.
