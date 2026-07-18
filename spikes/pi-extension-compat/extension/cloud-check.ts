import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function cloudCheckExtension(pi: ExtensionAPI): void {
  pi.registerCommand("cloud-check", {
    description: "Verify that an RPC client can bridge extension UI requests",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "AgentDock compatibility check",
        "Allow the remote client to complete this extension UI round trip?",
      );

      if (!confirmed) {
        ctx.ui.notify("AgentDock compatibility check was rejected.", "warning");
        return;
      }

      ctx.ui.notify("AgentDock extension UI round trip succeeded.", "info");
    },
  });
}
