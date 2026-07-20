# Network matrix

## Rule

No untrusted Tool Sandbox joins a platform network. Access is granted to a
trusted component only when its responsibility requires it. Network membership
does not replace application authentication.

## Production networks

| Component | Edge/API | Management | Database | Object storage | Sandbox control | GitHub control | Observability | Provider egress | Repository egress | Public ports |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Web ingress | yes | no | no | no | no | yes (webhook proxy only) | no | no | no | loopback `8080` |
| Control Plane | API | yes | yes | no | no | yes | metrics/trace | no | no | none |
| Trusted Pi Runner | no | yes | yes | yes | yes | yes | metrics/trace | yes | no | none |
| Sandbox Manager | no | no | no | no | yes | no | metrics/trace | no | no | none |
| GitHub Gateway | no | no | no | no | no | yes | no | yes | no | none |
| Tool Sandbox | no | no | no | no | no | no | no | no | no | none |
| Docker microVM trusted bridge (optional) | no | no | no | no | microVM-local only | no | no | bootstrap only, then deny-all | no | none |
| Repository importer | no | no | no | no | no | no | no | no | yes | none |
| PostgreSQL | no | no | yes | no | no | no | no | no | no | none |
| MinIO | no | no | no | yes | no | no | no | no | no | none |
| Prometheus / Jaeger / Grafana | no | no | no | no | no | no | yes | no | no | none |
| Observability ingress | separate loopback edge | no | no | no | no | no | proxy only | no | no | loopback `9090`, `16686`, `3001` |

The repository-network bootstrap is a credential-free one-shot container used
only to make Compose create the otherwise dynamic egress bridge. It exits before
normal service and importer work. The Manager controls importer lifecycle but
does not join repository egress itself.

The observability ingress is the only component joining the non-internal
`observability-edge` network. The three backends remain internal and are not
joined to `edge`, API, database, model/provider, GitHub, or sandbox-control
networks. Prometheus receives only its own scrape token; the proxy receives no
secret.

## Credential and authority matrix

| Component | Tenant API auth | Model secret | DB credential | Object-store credential | Manager token | GitHub App key/token | Docker socket |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser/Web | bearer token in browser memory | no | no | no | no | no | no |
| Control Plane | digest verification | encrypted credential authority | yes | no | no | no (service RPC only) | no |
| Trusted Pi Runner | no public token | turn-scoped gateway + trusted resolver | yes | scoped checkpoint identity | yes | no (service RPC only) | no |
| Sandbox Manager | no | no | no | no | own service-token verifier | no | **yes** |
| GitHub Gateway | no | no | no | no | no | **yes** | no |
| Tool Sandbox | no | no | no | no | no | no | no |
| Repository importer | no | no | no | no | no | no | no |

## Tool Sandbox denial targets

The integration suite attempts all of these from inside a live Tool Sandbox:

```text
control-plane:4100
postgres:5432
minio:9000
sandbox-manager:4300
host.docker.internal
1.1.1.1:443
```

All must be unreachable. It also inspects `env`, `/proc/self/environ`,
`/proc/1/environ`, PID 1's command line, cgroup limits, mounts, capabilities,
and Docker socket absence.

For `docker_microvm`, the same Tool Worker remains `network=none` inside the
VM. In addition, the outer Docker Sandbox proxy is switched to deny-all before
the trusted Tool image is loaded or the worker starts. The bridge's
microVM-local Docker socket is never mounted into the Tool Worker. A possible
template pull occurs earlier, with no tenant content or agent command present.

The Tool Sandbox is not attached to `github-control`, so enabling a GitHub App
does not give agent-generated commands a path to the Gateway. The Gateway is
attached to provider egress only for GitHub API traffic and to `github-control`
for authenticated internal RPC and normalized webhook delivery. It is not
attached to database, object storage, management, or sandbox control.

## Future dependency network

Dependency installation must not attach a Tool Sandbox to provider egress or a
platform bridge. The planned shape is:

```text
Tool Sandbox
    -> authenticated narrow egress proxy
       -> DNS-resolved allowlist
          -> selected Maven/npm/PyPI endpoints
```

The proxy must address DNS rebinding, redirects, IP literals, private/link-local
ranges, request size, response size, method restrictions, logging redaction,
and per-run budget. Until that slice exists, Tool execution remains offline.
