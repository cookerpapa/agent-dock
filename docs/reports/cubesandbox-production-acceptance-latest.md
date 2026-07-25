# CubeSandbox production acceptance

- Checked at: 2026-07-25T04:52:08.261Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 3204 ms / 3627 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 15099 ms / 17397 ms
- Follow-up first text / settled: 10028 ms / 11818 ms
- Coding Tool calls: 2 + 3
- Distinct Cube KVM guests: true
- Workspace restored across Runs: true
- Real input/output/cache-read tokens: 2071 / 1834 / 21120
- Semantic compaction: 82 source events -> 8 transcript items
- Cross-tenant conversation hidden: true
- Remaining test-session Cube microVMs: 0

A real-model chat Run completed without touching Cube. Two later coding Runs in the same Session used different KVM guests; the follow-up restored, read and modified the first Run's committed counting-sort file. Provider usage, semantic projections, cross-tenant API denial and exact Cube cleanup were all verified.
