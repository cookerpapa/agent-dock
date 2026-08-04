# CubeSandbox production acceptance

- Checked at: 2026-08-04T16:54:16.652Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1671 ms / 1874 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 9841 ms / 13580 ms
- Follow-up first text / settled: 6945 ms / 8427 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / checkpoint reference: 3770 / 696326 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 6870 / 2519 / 39936
- Semantic compaction: 63 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 5 / 5
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two coding Runs reused one running Session-bound Cube KVM guest through a checkpoint boundary, rotated Tool authority and higher-fence rebind. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction and deletion of its local POSIX Workspace copy, its follow-up restored the marker and repository from the committed Kopia snapshot into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
