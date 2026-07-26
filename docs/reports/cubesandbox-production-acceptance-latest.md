# CubeSandbox production acceptance

- Checked at: 2026-07-26T11:05:03.377Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1359 ms / 1598 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8679 ms / 15930 ms
- Follow-up first text / settled: 9448 ms / 17906 ms
- Coding Tool calls: 2 + 3
- Same sealed Cube KVM guest reused: true
- Workspace restored across Runs: true
- Large Workspace files / checkpoint reference: 3664 / 669487 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2750 / 2476 / 36864
- Semantic compaction: 59 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 5 / 5
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two coding Runs reused one physical Cube KVM guest through a sealed pause/connect and higher-fence rebind. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction, its follow-up restored the marker and repository into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
