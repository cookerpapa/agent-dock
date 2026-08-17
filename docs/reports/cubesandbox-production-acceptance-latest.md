# CubeSandbox production acceptance

- Checked at: 2026-08-17T13:27:45.223Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1344 ms / 1571 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 9114 ms / 9989 ms
- Follow-up first text / settled: 8738 ms / 9575 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Persistent Sandbox policy / archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 3215 / 590953 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 4062 / 1789 / 34688
- Semantic compaction: 65 source events -> 8 transcript items
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. A persistent conversation propagated its retention policy through the complete product path, and two coding Runs reused one running Session-bound Cube KVM guest with rotated Tool authority and higher-fence rebind. Archiving that conversation caused the retained Cube to be reaped. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run cloned a large repository; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
