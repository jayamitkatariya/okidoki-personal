import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      // Two pages: the dashboard (index) and the standalone session joiner (collab), each inlined.
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        collab: fileURLToPath(new URL("./collab.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
  },
});
