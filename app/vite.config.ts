/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist" },
  css: { modules: { generateScopedName: "[name]__[local]__[hash:base64:4]" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
