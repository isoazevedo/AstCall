/**
 * SPA do modo standalone: tela de login + o mesmo <ast-monitor> usado no AzCall.
 * `createApp` cria a aplicação Vue e `mount` a coloca no #app do index.html.
 */
import { createApp } from 'vue';
import '../element'; // registra <ast-monitor>, <ast-filas>, <ast-ramais> e <ast-chamadas>
import './theme.css';
import StandaloneApp from './StandaloneApp.vue';

createApp(StandaloneApp).mount('#app');
