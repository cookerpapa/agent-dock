# Multi-tenant real-model load acceptance

- Checked at: 2026-07-25T14:42:22.488Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: agent-dock-supervisor-2=6, agent-dock-supervisor-1=6
- Acceptance p50/p95: 27 / 39 ms
- First text p50/p95: 3542 / 13257 ms
- Settled p50/p95: 5611 / 16525 ms
- Queue wait p50/p95: 2291 / 12255 ms
- Real requests/input/output/cache-read tokens: 12 / 1362 / 2128 / 15360

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the same Temporal Task Queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
