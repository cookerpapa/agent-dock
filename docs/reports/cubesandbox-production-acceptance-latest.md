# CubeSandbox production acceptance

- Checked at: 2026-08-21T19:51:31.073Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 2570 ms / 2958 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8054 ms / 9076 ms
- Follow-up first text / settled: 5386 ms / 6163 ms
- Coding Tool calls: 2 + 2
- Same running Session Cube KVM guest reused: true
- Persistent Sandbox policy / archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 149589 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2202 / 2873 / 102144
- Canonical conversation: 3 terminal Turns / 17 Pi entries / 13824 bytes
- Kafka Raw / Accepted / Session Mutation end offsets: 181 / 192 / 167
- PostgreSQL hot-event table absent / projected Session mutations: true / 41
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. A persistent conversation propagated its retention policy through the complete product path, and two coding Runs reused one running Session-bound Cube KVM guest with rotated Tool authority and higher-fence rebind. Archiving that conversation caused the retained Cube to be reaped. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
