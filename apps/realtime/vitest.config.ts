import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Usa o código-fonte do @astcall/shared nos testes (sem precisar de build).
  resolve: { conditions: ['development'] },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
