import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Configuração inicial do Vite (modo SPA standalone).
// O build como Web Component (modo biblioteca) entra no item 7 do roadmap.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // Em desenvolvimento, encaminha HTTP e WebSocket para o backend (mesmo domínio, sem CORS).
    proxy: {
      '/auth': 'http://127.0.0.1:8090',
      '/monitor-ws': { target: 'ws://127.0.0.1:8090', ws: true },
    },
  },
});
