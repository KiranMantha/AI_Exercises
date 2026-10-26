import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// In dev the page runs on Vite and /api is forwarded to the chat API.
export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: { "/api": `http://localhost:${process.env.API_PORT ?? 3001}` },
  },
});
