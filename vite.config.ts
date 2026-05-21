import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        fab: resolve(__dirname, "fab.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
