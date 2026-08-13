# Network matrix

| Source | Destination | Allowed | Purpose |
| --- | --- | --- | --- |
| Browser | Web/Control Plane/Event Gateway | yes | product API and SSE |
| Control Plane | PostgreSQL | yes | product/Run authority |
| Control Plane | Event Gateway | yes | live projection coordination |
| Pi Worker | PostgreSQL | yes | queue, Session and lifecycle state |
| Pi Worker | Event Gateway | yes | authenticated event batches |
| Pi Worker | Tool Broker | yes | fenced Tool RPC |
| Pi Worker | provider proxy/model provider | yes | model requests |
| Event Gateway | PostgreSQL/Kafka/Valkey | yes | ingest, projection, replay |
| Tool Broker | PostgreSQL | yes | activation and authority state |
| Tool Broker | Cube API | yes | KVM lifecycle |
| Volume gateway | PostgreSQL/RWX Workspace storage | yes | revision/Volume coordination |
| Cube guest | egress proxy | optional | governed public HTTP/HTTPS |
| Cube guest | platform services/internal/metadata | no | no route/credential |
| Cube guest | other Workspace Volumes | no | mount isolation |

The Sandbox default is deny-all. Public mode routes HTTP/HTTPS through the Cube
egress gateway, which blocks loopback, RFC1918, link-local, metadata, Kubernetes
and platform destinations. Allowing public egress does not grant direct access
to the trusted cluster network.

Kubernetes NetworkPolicy must be enforced by the selected CNI. External CIDRs
must be explicit; `0.0.0.0/0` is not a valid trusted-plane escape hatch.
