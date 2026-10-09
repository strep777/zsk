import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000"
    }
  },
  preview: {
    port: 4173
  },
  build: {
    outDir: "dist/client",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.replace(/\\/g, "/").includes("/node_modules/katex/")) return "math-renderer";
        }
      }
    }
  }
});
