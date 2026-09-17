import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': '/src',
      // 直接引用 core 源码，避免 core dist 未重建导致 dev 页面跑旧代码
      '@labelfaster/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url)
      ),
    },
  },
});
