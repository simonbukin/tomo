import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": '"production"' },
  publicDir: false,
  build: {
    target: "safari15",
    outDir: "src-tauri/agentation",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    lib: { entry: "src/addons/agentation/page/entry.tsx", formats: ["iife"], name: "TomoAgentation", fileName: () => "agentation.js" },
  },
});
