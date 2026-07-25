# CubeSandbox production acceptance

- Checked at: 2026-07-25T18:11:31.621Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1083 ms / 1299 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 8567 ms / 10592 ms
- Follow-up first text / settled: 8109 ms / 9234 ms
- Coding Tool calls: 2 + 3
- Distinct Cube KVM guests: true
- Workspace restored across Runs: true
- Real input/output/cache-read tokens: 1979 / 1723 / 18944
- Semantic compaction: 81 source events -> 8 transcript items
- Temporal Workflows / bounded-reference histories: 3 / 3
- Cross-tenant conversation hidden: true
- Remaining test-session Cube microVMs: 0

A real-model chat Run completed without touching Cube. Two later coding Runs in the same Session used different KVM guests; the follow-up restored, read and modified the first Run's committed counting-sort file. All three Runs completed through Temporal, whose decoded histories contained only bounded references/status. Provider usage, semantic projections, cross-tenant API denial and exact Cube cleanup were all verified.
