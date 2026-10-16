import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Usa o código-fonte do @astcall/shared (sem build)
  resolve: { conditions: ['development'] },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
