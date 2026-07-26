# CubeSandbox production acceptance

- Checked at: 2026-07-26T16:43:43.197Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1504 ms / 1757 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 10732 ms / 21113 ms
- Follow-up first text / settled: 7707 ms / 21002 ms
- Coding Tool calls: 2 + 3
- Same sealed Cube KVM guest reused: true
- Workspace restored across Runs: true
- Large Workspace files / checkpoint reference: 3664 / 669559 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 4069 / 2444 / 46720
- Semantic compaction: 89 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 5 / 5
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two coding Runs reused one physical Cube KVM guest through a sealed pause/connect and higher-fence rebind. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction and deletion of its local POSIX Workspace copy, its follow-up restored the marker and repository from the committed Kopia snapshot into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
