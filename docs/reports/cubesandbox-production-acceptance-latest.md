# CubeSandbox production acceptance

- Checked at: 2026-07-28T17:24:47.603Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1635 ms / 1863 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8660 ms / 10920 ms
- Follow-up first text / settled: 7237 ms / 8186 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Workspace restored across Runs: true
- Large Workspace files / checkpoint reference: 3679 / 672067 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 4023 / 2355 / 41344
- Semantic compaction: 70 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 5 / 5
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two coding Runs reused one running Session-bound Cube KVM guest through a checkpoint boundary, rotated Tool authority and higher-fence rebind. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction and deletion of its local POSIX Workspace copy, its follow-up restored the marker and repository from the committed Kopia snapshot into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
