import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV__: true,
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/mobile/src', import.meta.url)),
    },
  },
});
