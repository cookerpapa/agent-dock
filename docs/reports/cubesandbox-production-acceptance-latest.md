# CubeSandbox production acceptance

- Checked at: 2026-08-12T17:16:55.672Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 3520 ms / 3662 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8490 ms / 10334 ms
- Follow-up first text / settled: 9046 ms / 10003 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Persistent Sandbox policy / archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / checkpoint reference: 3816 / 707939 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 6574 / 2156 / 29952
- Semantic compaction: 81 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 5 / 5
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. A persistent conversation propagated its retention policy through the complete product path, and two coding Runs reused one running Session-bound Cube KVM guest through a checkpoint boundary with rotated Tool authority and higher-fence rebind. Archiving that conversation caused the retained Cube to be reaped. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction and deletion of its local POSIX Workspace copy, its follow-up restored the marker and repository from the committed Kopia snapshot into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.
