import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Dois builds:
 * - padrão (`vite build`): a SPA standalone (login + painel) em dist/;
 * - `vite build --mode element`: só o Web Component, um arquivo ES em dist/element/
 *   (com o Vue embutido), para o AzCall incluir com <script type="module">.
 *
 * Arquivos *.ce.vue são compilados em modo custom element (CSS vai para o Shadow DOM).
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    vue({
      template: {
        // Tags <ast-*> são Web Components, não componentes Vue
        compilerOptions: { isCustomElement: (tag) => tag.startsWith('ast-') },
      },
    }),
  ],
  define: mode === 'element' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : undefined,
  build:
    mode === 'element'
      ? {
          outDir: 'dist/element',
          lib: {
            entry: 'src/element/index.ts',
            formats: ['es'],
            fileName: () => 'ast-monitor.js',
          },
        }
      : { outDir: 'dist' },
  server: {
    port: 5173,
    // Em desenvolvimento, encaminha HTTP e WebSocket para o backend (mesmo domínio, sem CORS)
    proxy: {
      '/auth': 'http://127.0.0.1:8090',
      '/monitor-ws': { target: 'ws://127.0.0.1:8090', ws: true },
    },
  },
}));
