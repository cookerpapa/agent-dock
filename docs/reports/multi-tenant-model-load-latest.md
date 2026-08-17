# Multi-tenant real-model load acceptance

- Checked at: 2026-08-17T12:57:38.569Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: agent-dock-worker-1=6, agent-dock-worker-2=6
- Acceptance p50/p95: 45 / 101 ms
- First text p50/p95: 4526 / 9662 ms
- Settled p50/p95: 5548 / 12379 ms
- Queue wait p50/p95: 3650 / 9039 ms
- Canonical Turn projections / source events / semantic items: 12 / 228 / 12
- Source events per Run / canonical payload bytes: 19 / 8030
- Real requests/input/output/cache-read tokens: 12 / 870 / 1225 / 12288

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
