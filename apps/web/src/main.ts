import { createApp } from 'vue';
import App from './App.vue';

// Ponto de entrada da SPA standalone.
// createApp cria a aplicação Vue a partir do componente raiz e mount a "pendura" no #app do index.html.
createApp(App).mount('#app');
