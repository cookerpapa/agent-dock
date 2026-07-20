# Docker microVM Sandbox evaluation

Generated 2026-07-20. Reproduce with:

```bash
npm run sandbox-microvm:check
```

## Environment

| Item | Value |
| --- | --- |
| Docker Engine | 29.4.2 |
| Docker Sandboxes client/server | v0.12.0, commit `f13b3c1a96a8be40b06473bb3db0c26dbfe1878c` |
| Host kernel | `6.6.87.2-microsoft-standard-WSL2` |
| Guest kernel | `6.12.67-linuxkit` |
| Trusted shell template | `docker/sandbox-templates@sha256:bd90847e98720dde718fe95b24bd4c7d9d4de41966339eb8bf3ab2bb683259e5` |

## Result

| Gate | Result | Wall time |
| --- | ---: | ---: |
| Provider security/lifecycle/reconciliation | 1 passed, 0 failed | 142.714 s |
| Pinned Pi remote `bash/edit/bash` Java repair | 1 passed, 0 failed | 118.752 s |
| Managed microVMs remaining | 0 | — |

The first gate verifies the distinct kernel, non-root/read-only nested worker,
inner `network=none`, outer deny-all policy, no credential/socket exposure,
effective CPU/memory/PID limits, path traversal denial, cancellation, snapshot,
fresh-Manager inventory, fenced termination, and exact VM cleanup. The second
runs pinned Pi through the same Manager/Tool RPC and produces the expected Java
patch without an external model call.

These durations include exporting the 263 MB Tool image into a fresh test state
directory and loading it into a new VM. They are cold-path evidence, not a
steady-state SLO. The tested CLI does not expose VM-level CPU/memory sizing;
AgentDock enforces the requested limits on the nested Tool Worker. This test
also does not establish public anonymous-SaaS safety.
