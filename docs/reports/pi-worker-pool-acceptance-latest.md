# Pi Worker pool production acceptance

- Checked at: 2026-08-14T15:29:51.585Z
- Provider/model: deepseek / deepseek-v4-flash
- Worker deployment: compose
- Active Workers: agent-dock-worker-1, agent-dock-worker-2
- Cross-Worker restore: agent-dock-worker-1 -> agent-dock-worker-2
- PostgreSQL Pi Session restored: true
- Previous-turn marker recovered: true
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: agent-dock-worker-2, agent-dock-worker-1, agent-dock-worker-1, agent-dock-worker-2
- Real requests/input/output tokens: 6 / 278 / 996

The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL SessionStorage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.
