import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The session joiner, built on its own so every chunk inlines into collab.html. A shared multi-entry
// build leaves cross-entry chunks external, and the singlefile plugin removes them — a page that
// 404s its own JS. Two single-entry builds keep both pages self-contained. Runs after the main build
// (emptyOutDir stays off so index.html survives).
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./collab.html", import.meta.url)),
    },
  },
});
