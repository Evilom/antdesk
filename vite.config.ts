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
        quick: resolve(__dirname, "quick.html"),
        pet: resolve(__dirname, "pet.html"),
        notepad: resolve(__dirname, "notepad.html"),
        menu: resolve(__dirname, "menu.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
