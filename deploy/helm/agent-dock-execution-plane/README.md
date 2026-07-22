# AgentDock execution-plane chart

This chart owns AgentDock's gVisor RuntimeClass, restricted execution
namespaces, workload identities, scoped Sandbox Manager RBAC, default-deny
network graph, and controlled dependency/repository egress proxy.

It intentionally does not deploy the Control Plane, Runner, Sandbox Manager,
database or object store. Those trusted services retain the outbound-only
topology described in `docs/PRODUCTION_DEPLOYMENT.md`.

Validate without cluster authority:

```bash
npm run helm:check
```

The supported host installer performs the ownership migration and installation.
For an already prepared cluster, an administrator can run the equivalent fixed
release:

```bash
helm upgrade --install agent-dock-execution-plane \
  deploy/helm/agent-dock-execution-plane \
  --namespace default \
  --take-ownership \
  --history-max 10 \
  --timeout 2m
```

The command deliberately does not use `--wait`: the proxy's public verification
key is published by the separately deployed trusted Sandbox Manager, so a fresh
proxy cannot become ready before that service starts. Production readiness and
`npm run sandbox:check` verify the complete dependency order.

The chart has a closed values schema. Values can select the trusted proxy image,
bounded replica/resources/placement settings, and RuntimeClass overhead. They
cannot change the `runsc` handler, execution namespaces, identities, RBAC,
network destinations or externally expose a service.
