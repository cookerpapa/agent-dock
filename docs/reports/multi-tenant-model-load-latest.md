# Multi-tenant real-model load acceptance

- Checked at: 2026-08-17T13:29:39.415Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: pi-cloud-worker-2=6, pi-cloud-worker-1=6
- Acceptance p50/p95: 35 / 48 ms
- First text p50/p95: 3005 / 8553 ms
- Settled p50/p95: 4496 / 11471 ms
- Queue wait p50/p95: 2275 / 7844 ms
- Canonical Turn projections / source events / semantic items: 12 / 255 / 12
- Source events per Run / canonical payload bytes: 21.25 / 8282
- Real requests/input/output/cache-read tokens: 12 / 924 / 1332 / 12288

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
