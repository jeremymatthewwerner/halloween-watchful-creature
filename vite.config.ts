import { defineConfig } from "vite";

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
});
