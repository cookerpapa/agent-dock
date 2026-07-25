# CubeSandbox production acceptance

- Checked at: 2026-07-25T10:21:06.960Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1134 ms / 1436 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 9724 ms / 12888 ms
- Follow-up first text / settled: 7669 ms / 8965 ms
- Coding Tool calls: 2 + 3
- Distinct Cube KVM guests: true
- Workspace restored across Runs: true
- Real input/output/cache-read tokens: 1342 / 1473 / 17920
- Semantic compaction: 78 source events -> 8 transcript items
- Cross-tenant conversation hidden: true
- Remaining test-session Cube microVMs: 0

A real-model chat Run completed without touching Cube. Two later coding Runs in the same Session used different KVM guests; the follow-up restored, read and modified the first Run's committed counting-sort file. Provider usage, semantic projections, cross-tenant API denial and exact Cube cleanup were all verified.
