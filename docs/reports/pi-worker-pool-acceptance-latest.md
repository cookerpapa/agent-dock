# Pi Worker pool production acceptance

- Checked at: 2026-07-25T18:15:03.441Z
- Provider/model: deepseek / deepseek-v4-flash
- Worker deployment: kubernetes
- Active Workers: agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-1
- Cross-Worker restore: agent-dock-pi-worker-local-v1-1 -> agent-dock-pi-worker-local-v1-0
- Pi session artifact restored: true
- Previous-turn marker recovered: true
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-1, agent-dock-pi-worker-local-v1-0, agent-dock-pi-worker-local-v1-1
- Real requests/input/output tokens: 7 / 585 / 1407

The owning Pi Worker was stopped after the first real-model turn. The surviving Worker restored the native Pi JSONL checkpoint, answered from the previous turn, and committed a new checkpoint. Four further real-model Runs then occupied both independent Worker connections.
