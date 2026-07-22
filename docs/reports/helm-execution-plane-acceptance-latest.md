# Helm execution-plane acceptance

- Checked at: 2026-07-23T06:52:32+08:00
- Release: `agent-dock-execution-plane`
- Chart: `agent-dock-execution-plane` 0.1.0
- RuntimeClass: `agent-dock-gvisor` -> `runsc`
- Ready dependency-egress proxy endpoints: 2
- Production trust fingerprint checks: 8/8 matched
- Manager live gVisor tests: 5/5 passed
- Trusted Pi Runner tests: 2/2 passed
- Clean-prewarm first tool: 2,488 ms
- Cold first tool: 4,214 ms
- Real-model post-upgrade turns: 2/2 completed
- Exact warm assignment cleanup: passed

The in-place Helm takeover retained the fixed gVisor runtime and production
capability trust root while bringing the execution-plane resources under one
versioned release. The runtime Manager identity can inspect only its explicitly
named RuntimeClass, Service/Endpoints and trust ConfigMap; attempts to read the
Deployment, PodDisruptionBudget and NetworkPolicy remained forbidden. Their
rendered security and availability contracts are therefore checked in CI,
while runtime behavior is proven by the live gVisor and production model gates.

The post-upgrade dynamic gate imported a fixed public GitHub commit through a
scoped capability, installed a real npm package in a disposable networked
bootstrap Pod, restored it into a fresh offline Pod, exercised clean prewarming,
cross-tenant isolation, cgroup/output limits, fencing and cleanup, and verified
that text-only Pi turns create no Tool Pod. The final production acceptance used
real model tokens for two coding turns, committed immutable Review Bundles,
reused the same exact-session gVisor Pod with a newer fence and destroyed it at
the terminal boundary.
