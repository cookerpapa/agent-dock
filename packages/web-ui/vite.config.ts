import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.AGENT_DOCK_DEMO_API_ORIGIN ?? "http://127.0.0.1:3100";
const webPort = Number(process.env.AGENT_DOCK_DEMO_WEB_PORT ?? "4173");
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error("AGENT_DOCK_DEMO_WEB_PORT must be an integer between 1 and 65535");
}
const apiProxy = {
  "/v1": {
    target: apiOrigin,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
