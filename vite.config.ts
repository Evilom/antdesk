import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    assetsDir: 'assets',
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        fab:  resolve(__dirname, 'fab.html'),
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      '/notion-api': {
        target: 'https://api.notion.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/notion-api/, ''),
        headers: { 'Notion-Version': '2025-09-03' },
      },
    },
  },
})
