# Long-context Pi compaction production acceptance

- Checked at: 2026-08-22T06:02:42.383Z
- Revision: `ccc33ff84f70c358a18c2e27eba8a9a410567fc2`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before first completed compaction: 9
- Compaction reason/tokens: threshold, 112469 -> 22926
- Compaction duration: 24192 ms
- Triggering Run first-response/settled: 1919 / 101987 ms
- Post-compaction recall first-response/settled: 1465 / 1915 ms
- Post-compaction coding first-response/settled: 1420 / 88366 ms
- Cross-Worker recovery: pi-cloud-worker-1 -> pi-cloud-worker-2
- Same persistent Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 156 / 155 / 1
- Real input/output/cache-read/cache-write tokens: 158151 / 103577 / 7906944 / 0
- Final Pi SessionStorage bytes/entries: 497213 / 319
- Final active context bytes/entries: 156912 / 80

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a persistent CubeSandbox KVM. Pi completed native threshold/overflow compaction, retained an early conversation invariant, continued coding after compaction, and restored the compacted native Session on a different Worker while rebinding the same persistent Cube runtime.
