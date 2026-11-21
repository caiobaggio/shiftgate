import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [root] },
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/internal": "http://127.0.0.1:8080",
      "/dev": "http://127.0.0.1:8080",
    },
  },
});
