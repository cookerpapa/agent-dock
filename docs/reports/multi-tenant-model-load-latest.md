# Multi-tenant real-model load acceptance

- Checked at: 2026-08-08T08:56:05.891Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: agent-dock-pi-worker-local-v1-1=6, agent-dock-pi-worker-local-v1-0=6
- Acceptance p50/p95: 32 / 43 ms
- First text p50/p95: 4650 / 15222 ms
- Settled p50/p95: 5766 / 17107 ms
- Queue wait p50/p95: 2726 / 12143 ms
- Persisted events / assistant text events / events per Run: 255 / 207 / 21.25
- Persisted event payload bytes: 12253
- Real requests/input/output/cache-read tokens: 12 / 882 / 2118 / 16896

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the same Temporal Task Queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
