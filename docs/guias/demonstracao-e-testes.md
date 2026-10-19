# Demonstração e testes

> Para quem quer conhecer o painel, testar uma versão nova ou preparar uma apresentação —
> **sem precisar de um Asterisk**. Requisito: Node.js 22 ou superior.

## PBX de demonstração

O AstCall traz um **PBX simulado** que fala o mesmo protocolo do Asterisk (AMI) e gera um dia de
operação fictício: 40 ramais (2001 em diante, com nomes de pessoas), filas **suporte**,
**vendas** e **financeiro**, clientes ligando de fora, conversas entre ramais, atendentes pausados
e alguns ramais desconectados. Nada é real — dá para testar todas as ações à vontade.

```bash
npm install
npm run keys:generate          # só na primeira vez
npm run user add admin         # só na primeira vez (responda "all" nas permissões)

npm run demo                   # terminal 1: PBX simulado + backend
npm run dev:web                # terminal 2: painel
```

Abra **http://localhost:5173** e entre com o usuário criado.

| Endereço                           | O que mostra                                |
| ---------------------------------- | ------------------------------------------- |
| `/`                                | painel completo                             |
| `/#usuarios`                       | tela de usuários                            |
| `/?tv`                             | modo TV (`/?tv&rotate=30` muda o intervalo) |
| `/?widgets` ou `/?widgets=suporte` | página de exemplo com os widgets            |

Opções do simulador: `npm run demo -- --endpoints 80 --queues 5 --members 6 --calls 30 --talk 60`
(ramais, filas, atendentes por fila, chamadas simultâneas, duração média da conversa em segundos).

> O `npm run demo` usa a porta 8090, a mesma do `npm run dev:realtime`: rode um ou outro.
> As filas levam alguns minutos para acumular números (atendidas, espera média).

### Roteiro rápido de teste

- [ ] O selo fica em **Tempo real**; chamadas e ramais mudam sozinhos.
- [ ] **Filas**: clientes aguardando com o tempo contando (amarelo após 1 min, vermelho após 3).
- [ ] Menu **⋮** de uma chamada: escutar, transferir e desligar abrem os diálogos.
- [ ] Menu **⋮** de um atendente: pausar com motivo, retomar, alterar penalidade.
- [ ] **Adicionar** um ramal a uma fila: ele aparece como **dinâmico** e pode ser removido.
- [ ] **Modo TV**: rodízio liga/desliga, a escolha continua após recarregar.
- [ ] **Usuários**: criar um usuário só com "Ver o painel", entrar com ele numa janela anônima e
      conferir que nenhuma ação aparece.
- [ ] Tema claro e escuro (preferência do sistema operacional).

## Testes automáticos

```bash
npm test                # todos os testes (backend e painel)
npm run typecheck       # tipos
npm run lint            # ESLint
```

Os testes do backend reproduzem **gravações reais** de um Asterisk 20 (chamada atendida, não
atendida, transferências, filas, escuta, ações do painel) e conferem o estado em cada ponto —
inclusive que um navegador que entra no meio chega exatamente ao estado do servidor.

## Teste de carga

```bash
npm run load-test                                     # cenário padrão (~1 min)
npm run load-test -- --endpoints 2000 --calls 1000 --clients 100 --scoped 50
```

Sobe o backend real com um PBX e navegadores simulados e mede eventos por segundo, uso de CPU e
memória, atraso até o navegador e se o estado de cada navegador bate com o do servidor.
Resultados e como ler: [testes de carga](../CARGA.md).

## Prints da documentação

Com o `npm run demo` e o `npm run dev:web` rodando:

```bash
# PowerShell:  $env:SHOT_USER="admin"; $env:SHOT_PASSWORD="..."; npm run screenshots
SHOT_USER=admin SHOT_PASSWORD=... npm run screenshots
```

Abre o Edge/Chrome sem janela, entra no painel, prepara cada tela (abas, menus, diálogos) e grava
os PNGs em `docs/img/`, além do GIF do README (`astcall-ao-vivo.gif`) e da imagem de prévia de links (`social-preview.png`, enviada em GitHub → Settings → Social preview) (`-- --copy <pasta>` copia também para outra pasta). O usuário precisa de
todas as permissões.
