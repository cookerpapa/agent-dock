# Pi Worker pool production acceptance

- Checked at: 2026-08-12T16:58:13.533Z
- Provider/model: deepseek / deepseek-v4-flash
- Worker deployment: kubernetes
- Active Workers: agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-1
- Cross-Worker restore: agent-dock-pi-worker-local-v1-1 -> agent-dock-pi-worker-local-v1-0
- Pi session artifact restored: true
- Previous-turn marker recovered: true
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-1, agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-0
- Real requests/input/output tokens: 9 / 351 / 1359

The owning Pi Worker was stopped after the first real-model turn. The surviving Worker restored the native Pi JSONL checkpoint, answered from the previous turn, and committed a new checkpoint. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.
