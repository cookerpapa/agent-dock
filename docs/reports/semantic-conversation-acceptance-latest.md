# Semantic conversation production acceptance

- Checked at: 2026-07-23T14:30:52.184Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 4127 ms / 4332 ms
- Pure-chat Sandbox activations: 0
- Coding first text / settled: 5186 ms / 5793 ms
- Coding Tool calls: 1
- Real input/output tokens: 247 / 227
- Semantic compaction: 15 source events -> 3 transcript items
- Durable replay high-water: 15 / 15 events
- Sandbox runtime: pi-cloud-gvisor
- Exact Sandbox cleanup: true

A real-model chat turn completed without provisioning a Sandbox. A second turn created and verified a file inside a gVisor Tool Sandbox. Both terminal turns committed semantic transcript projections, the conversation resumed SSE at the durable high-water mark without historical delta replay, real token usage was persisted, and the exact retained Sandbox assignment was destroyed.
