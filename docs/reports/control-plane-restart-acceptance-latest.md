# Control Plane restart acceptance

- Checked at: 2026-08-17T13:30:19.374Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 92
- SSE reconnects: 0
- Run Attempts: 1
- Elapsed: 33166 ms

The Control Plane container received SIGKILL after the first committed assistant delta. The independently hosted Event Gateway continued the durable SSE stream while a replacement Control Plane started and the original fenced Worker execution completed. The Run completed with one Attempt; any transport reconnects are reported rather than required.
