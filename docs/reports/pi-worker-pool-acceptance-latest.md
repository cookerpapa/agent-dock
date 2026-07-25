# Pi Worker pool production acceptance

- Checked at: 2026-07-25T09:24:33.428Z
- Provider/model: deepseek / deepseek-v4-flash
- Active Workers: agent-dock-supervisor-1, agent-dock-supervisor-2
- Cross-Worker restore: agent-dock-supervisor-1 -> agent-dock-supervisor-2
- Pi session artifact restored: true
- Previous-turn marker recovered: true
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: agent-dock-supervisor-2, agent-dock-supervisor-1, agent-dock-supervisor-1, agent-dock-supervisor-1
- Real requests/input/output tokens: 6 / 496 / 1252

The owning Pi Worker was stopped after the first real-model turn. The surviving Worker restored the native Pi JSONL checkpoint, answered from the previous turn, and committed a new checkpoint. Four further real-model Runs then occupied both independent Worker connections.
