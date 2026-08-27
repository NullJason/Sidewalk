import { defineConfig } from "vite";

// The Express server (server/index.ts) listens on 3000. Forwarding /api/* keeps the
// browser on Vite's origin, so there is no CORS to configure in local dev.
export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  }
});
