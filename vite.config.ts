import { defineConfig } from "vite";

// The Express server (server/index.ts) listens on PORT, defaulting to 3000, and reads
// it from the same environment this does — so moving the server moves the proxy with
// it. Forwarding /api/* keeps the browser on Vite's origin, so there is no CORS to
// configure in local dev.
const SERVER_PORT = process.env.PORT ?? "3000";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true
      }
    }
  }
});
