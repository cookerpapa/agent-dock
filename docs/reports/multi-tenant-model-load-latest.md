# Multi-tenant real-model load acceptance

- Checked at: 2026-08-17T14:41:12.674Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: pi-cloud-worker-2=6, pi-cloud-worker-1=6
- Acceptance p50/p95: 75 / 162 ms
- First text p50/p95: 5313 / 11492 ms
- Settled p50/p95: 6266 / 14319 ms
- Queue wait p50/p95: 4293 / 10770 ms
- Canonical Turn projections / source events / semantic items: 12 / 250 / 12
- Source events per Run / canonical payload bytes: 20.83 / 8785
- Real requests/input/output/cache-read tokens: 12 / 888 / 1380 / 12288

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
