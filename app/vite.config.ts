import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/bakaloriastages/",
  plugins: [react()],
  build: {
    outDir: "../docs",
    emptyOutDir: true,
    sourcemap: false,
  },
});
