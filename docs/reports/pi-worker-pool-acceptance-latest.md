# Pi Worker pool production acceptance

- Checked at: 2026-08-21T16:04:05.382Z
- Provider/model: deepseek / deepseek-v4-flash
- Worker deployment: compose
- Active Workers: pi-cloud-worker-1, pi-cloud-worker-2
- Cross-Worker restore: pi-cloud-worker-1 -> pi-cloud-worker-2
- PostgreSQL Pi Session restored: true
- Previous-turn marker recovered: true
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: pi-cloud-worker-2, pi-cloud-worker-1, pi-cloud-worker-1, pi-cloud-worker-2
- Real requests/input/output tokens: 6 / 326 / 1094

The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL SessionStorage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.
