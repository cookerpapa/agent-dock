# Long-context Pi compaction production acceptance

- Checked at: 2026-08-14T15:23:57.775Z
- Tested source commit: `02603f56e881cb68e499fd9e96ad93963b430ffc`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before first completed compaction: 11
- Compaction reason/tokens: threshold, 113920 -> 22667
- Compaction duration: 18294 ms
- Triggering Run first-response/settled: 4169 / 92712 ms
- Post-compaction recall first-response/settled: 4750 / 4837 ms
- Post-compaction coding first-response/settled: 5071 / 68201 ms
- Cross-Worker recovery: agent-dock-worker-2 -> agent-dock-worker-1
- Same persistent Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 165 / 165 / 0
- Real input/output/cache-read/cache-write tokens: 168010 / 109063 / 8570624 / 0
- Final Pi SessionStorage bytes/entries: 524224 / 347
- Final active context bytes/entries: 136471 / 67

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a persistent CubeSandbox KVM. Pi completed native threshold/overflow compaction, retained an early conversation invariant, continued coding after compaction, and restored the compacted native Session on a different Worker while rebinding the same persistent Cube runtime.
