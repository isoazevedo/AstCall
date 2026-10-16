<script setup lang="ts">
// <script setup> é a forma recomendada da Composition API: tudo que for declarado
// aqui (variáveis, imports) fica disponível diretamente no <template>.
import { PROTOCOL_VERSION } from '@astcall/shared';
</script>

<template>
  <main class="placeholder">
    <h1>AstCall</h1>
    <p>Painel em construção — protocolo v{{ PROTOCOL_VERSION }}.</p>
  </main>
</template>

<style scoped>
/* "scoped" faz este CSS valer só para este componente. */
.placeholder {
  font-family: system-ui, sans-serif;
  padding: 2rem;
}
</style>
