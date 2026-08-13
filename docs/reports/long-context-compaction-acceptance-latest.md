# Long-context Pi compaction production acceptance

- Checked at: 2026-08-13T18:33:39.394Z
- Revision: `5dc43d2fa4182bbb6b7b994723d8d9e8b3e26b4b`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before first completed compaction: 11
- Compaction reason/tokens: threshold, 120984 -> 23524
- Compaction duration: 18923 ms
- Triggering Run first-response/settled: 2973 / 98578 ms
- Post-compaction recall first-response/settled: 3634 / 5418 ms
- Post-compaction coding first-response/settled: 3809 / 59774 ms
- Cross-Worker recovery: agent-dock-worker-1 -> agent-dock-worker-2
- Same persistent Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 150 / 147 / 3
- Real input/output/cache-read/cache-write tokens: 161235 / 106048 / 8018048 / 0
- Final Pi JSONL logical bytes/lines: 768395 / 311

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a persistent CubeSandbox KVM. Pi completed native threshold/overflow compaction, retained an early conversation invariant, continued coding after compaction, and restored the compacted native Session on a different Worker while rebinding the same persistent Cube runtime.
