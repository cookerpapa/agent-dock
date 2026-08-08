# Control Plane restart acceptance

- Checked at: 2026-08-08T08:51:27.417Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 126
- SSE reconnects: 12
- Run Attempts: 1
- Elapsed: 16199 ms

The Control Plane container received SIGKILL after the first committed assistant delta. A replacement instance resumed SSE from the durable cursor while the original fenced Temporal Activity completed on the Pi Worker. The Run completed with one Attempt.
