# CubeSandbox production acceptance

- Checked at: 2026-08-21T18:42:52.191Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 2477 ms / 2930 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8850 ms / 10346 ms
- Follow-up first text / settled: 3710 ms / 7965 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Persistent Sandbox policy / archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 149002 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2361 / 2319 / 88064
- Canonical conversation: 3 terminal Turns / 19 Pi entries / 17177 bytes
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. A persistent conversation propagated its retention policy through the complete product path, and two coding Runs reused one running Session-bound Cube KVM guest with rotated Tool authority and higher-fence rebind. Archiving that conversation caused the retained Cube to be reaped. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
