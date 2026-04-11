import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',  // 相对路径，打包后正确解析
  build: {
    assetsDir: 'assets',
    cssCodeSplit: false,
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
