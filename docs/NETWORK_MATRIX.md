# Network and credential matrix

## Default rule

Only an explicitly required connection is allowed. User code never joins a
platform service network.

| Source | Destination | Allowed | Credential |
| --- | --- | ---: | --- |
| Browser | Web ingress | yes | browser session cookie |
| Web ingress | Control Plane | yes | trusted internal route |
| Control Plane | PostgreSQL | yes | DB credential |
| Control Plane | PostgreSQL direct session endpoint | yes | DB credential; `LISTEN`/migration only |
| Control Plane | Temporal | yes | internal namespace |
| Event Gateway | Kafka brokers | yes | TLS + SCRAM-SHA-512, topic/group-scoped ACL |
| Event Gateway | Valkey | yes | private URL/TLS identity; live replay only |
| Event Gateway | PostgreSQL | yes | sequence validation, cursor and terminal-event credential |
| Live Stream Compactor | Valkey + PostgreSQL | yes | private URL + DB credential |
| Control Plane | Event Gateway internal projection | yes | dedicated service token |
| Control Plane | MinIO/S3 | yes | object-store credential |
| Control Plane | exact Pi Worker management endpoint | yes | management service token |
| Control Plane | Sandbox Manager Service | yes | materializer credential |
| Pi Worker | Control Plane management channel | yes | Worker boot credential |
| Pi Worker | Event Gateway internal ingest | yes | dedicated service token; no Kafka credential |
| Pi Worker | Model Gateway | yes | short-lived Run capability |
| Pi Worker | Sandbox Manager | yes | service identity + Tool lease |
| Sandbox Manager | Cube API/Proxy | yes | Cube API credential |
| Sandbox Manager | co-located Data Mover | yes | Data Mover service credential |
| Data Mover | Cube Volume/POSIX storage | yes | deployment identity |
| Data Mover | object storage | yes | scoped checkpoint credential |
| Cube guest | Cube egress gateway | yes | no platform credential |
| Cube guest | public HTTP/HTTPS | via gateway | none |
| Cube guest | private/link-local/metadata networks | no | none |
| Cube guest | Control Plane/PostgreSQL/Temporal/MinIO/Model Gateway | no | none |
| Cube guest | Cube control API | no | none |
| Cube guest | another tenant Workspace | no | none |

## Trusted product plane

Control Plane, Event Gateway, Kafka, Valkey, Temporal, PostgreSQL, object storage, model gateway and Worker
management use private deployment networks. Their credentials are injected only
into the service that needs them.

The Worker does not receive the Cube API key. The Sandbox Manager does not
receive the model provider key.

In the distributed profile, NetworkPolicy starts from denied ingress/egress.
In-cluster authorities must live in a namespace carrying the explicitly
reviewed trusted-plane label; external PostgreSQL, Temporal, S3, Cube, proxy
and OTLP addresses must use concrete operator-supplied CIDRs. Private image
registry access is a node/runtime concern and is authenticated with
`imagePullSecrets`, not with a credential mounted into application containers.

## Cube egress

The guest receives proxy environment variables pointing to the trusted gateway.
The gateway may connect directly or through the administrator-configured
upstream WSL/host proxy.

The gateway denies:

```text
loopback
RFC1918
carrier-grade NAT
link-local
cloud metadata
multicast/reserved/test ranges
platform service destinations
```

DNS rebinding is mitigated by resolving and validating the actual target
address at connection time. Redirects remain subject to the same validation.

## Credential placement

| Credential | Stored/used by | Must not enter |
| --- | --- | --- |
| model API key | encrypted DB + Model Gateway | browser, Cube |
| DB credential | Control Plane/trusted services | browser, Cube |
| object-store credential | Control Plane/Data Mover/Worker as scoped | browser, Cube |
| Temporal credential/config | Control Plane/Workers | browser, Cube |
| Cube API key | Sandbox Manager | browser, Pi prompt, Cube guest |
| browser password hash | authentication store | logs, browser response |
| Tool lease/handoff secret | Worker/Manager/guest Tool service | model context, Workspace |

## Hot proxy configuration

The platform administrator updates the proxy origin through a versioned Control
Plane API. The Cube egress gateway reloads the latest committed configuration
for new connections. Existing connections retain their already-established
route; no cluster restart is required.

## Evidence

Live acceptance attempts to reach every denied platform/private destination
from inside the guest, verifies public HTTPS through the gateway, checks the
guest environment for credentials, and proves a second tenant cannot read the
first tenant's Workspace.
