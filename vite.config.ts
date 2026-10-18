import { defineConfig, type Plugin } from "vite";
import { isLoopback } from "./server/auth.ts";

const serverPort = Number(process.env.PORT ?? 8787);

/**
 * The dev server only serves this computer: it hands out the project's files without any PIN, so
 * even if it's started with --host, other devices are turned away. The phone remote talks to the
 * creature server directly (http://<this computer>:8787/remote), which checks the PIN.
 */
const localOnly: Plugin = {
  name: "creature-local-only",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (isLoopback(req.socket.remoteAddress)) return next();
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`The dashboard dev server only serves this computer. On your phone, open http://<this computer>:${serverPort}/remote instead.\n`);
    });
  },
};

export default defineConfig({
  root: "web",
  plugins: [localOnly],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    // xfwd: the creature server sees who the request is really from (it treats loopback as the dashboard).
    proxy: {
      "/api": { target: `http://localhost:${serverPort}`, xfwd: true },
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true, xfwd: true },
    },
  },
});
