# Control Plane restart acceptance

- Checked at: 2026-08-12T17:03:41.915Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 148
- SSE reconnects: 0
- Run Attempts: 1
- Elapsed: 28569 ms

The Control Plane container received SIGKILL after the first committed assistant delta. The independently hosted Event Gateway continued the durable SSE stream while a replacement Control Plane started and the original fenced Temporal Activity completed on the Pi Worker. The Run completed with one Attempt; any transport reconnects are reported rather than required.
