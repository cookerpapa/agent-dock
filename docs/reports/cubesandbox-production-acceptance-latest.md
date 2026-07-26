# CubeSandbox production acceptance

- Checked at: 2026-07-26T02:29:16.814Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1244 ms / 1465 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 11901 ms / 28710 ms
- Follow-up first text / settled: 8156 ms / 31560 ms
- Coding Tool calls: 2 + 3
- Same sealed Cube KVM guest reused: true
- Workspace restored across Runs: true
- Real input/output/cache-read tokens: 1748 / 1580 / 20096
- Semantic compaction: 71 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 3 / 3
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two later coding Runs in the same Session reused one physical Cube KVM guest through a sealed pause/connect and higher-fence rebind; the follow-up read and modified the first Run's retained counting-sort file. All three Runs completed through Temporal, whose decoded histories contained only bounded references/status. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were all verified.
