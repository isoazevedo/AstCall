# Guia de uso do painel

> Para supervisores e operadores. Não precisa saber nada de servidor ou de Asterisk.
> Os prints usam o PBX de demonstração: nomes e números são fictícios.

O AstCall mostra, em tempo real, o que está acontecendo no seu PBX: quem está falando com quem,
quais ramais estão livres e como estão as filas de atendimento. Nada precisa ser atualizado: a
tela muda sozinha no instante em que algo acontece.

## Entrando

- **No AzCall:** menu **Monitoramento → AstCall**. Não há segundo login: vale o seu usuário do
  AzCall, e você vê só os ramais, filas e chamadas da sua empresa.
- **No AstCall standalone:** abra o endereço informado pelo administrador e entre com o usuário
  e a senha que ele criou para você.

![Tela de login do modo standalone](../img/login.png)

O selo no canto superior direito mostra a conexão: **Tempo real** (tudo certo), **Sincronizando**
(o painel está buscando o estado completo, leva poucos segundos), **PBX desconectado** ou
**Sessão expirada** (entre novamente).

## Visão geral

![Visão geral do painel](../img/painel-escuro.png)

No topo, os números do momento: chamadas ativas, em conversa, aguardando em fila, ramais online e
ramais ocupados.

Logo abaixo ficam as abas:

| Aba             | O que mostra                               |
| --------------- | ------------------------------------------ |
| **Visão geral** | tudo numa página: chamadas, ramais e filas |
| **Ramais**      | só os ramais                               |
| **Chamadas**    | só as chamadas em andamento                |
| **Filas**       | só as filas                                |

## Chamadas

![Aba Chamadas](../img/chamadas.png)

Cada linha é uma chamada, com os participantes (número e nome), a situação e a duração:

| Situação        | O que significa                                                        |
| --------------- | ---------------------------------------------------------------------- |
| **Discando**    | o ramal está discando                                                  |
| **Tocando**     | o destino está tocando (pisca)                                         |
| **Na fila**     | o cliente está aguardando numa fila                                    |
| **Em conversa** | as duas pontas estão falando — a duração conta a partir do atendimento |
| **Em espera**   | alguém colocou a chamada em espera                                     |

Indicações extras: **via fila X** (a chamada entrou por uma fila), **REC** (está sendo gravada) e
**Em escuta** (um supervisor está ouvindo). Transferências e consultas continuam aparecendo como
**uma chamada só**, com quem está falando agora.

### Ações de uma chamada — menu ⋮

Ao lado de cada participante há um botão **⋮** com as ações sobre aquele lado da chamada:

![Menu de ações de uma chamada](../img/menu-chamada.png)

- **Escutar** — o ramal que você informar toca; ao atender, você entra na chamada em um de três
  modos:
  - **Ouvir**: escuta em silêncio;
  - **Sussurrar**: fala só com o seu atendente (o cliente não ouve);
  - **Intervir**: fala com os dois lados.

  O ramal que vai tocar pode ser qualquer um — por exemplo, o de um diretor que quer ouvir uma
  ligação. O painel lembra o último ramal usado.

  ![Diálogo de escuta](../img/escuta.png)

- **Transferir** — leva esse participante para outro número ou ramal (transferência direta).
- **Desligar** — encerra a chamada desse participante (pede confirmação).

Só aparecem as ações que o seu usuário tem permissão de usar e que fazem sentido no momento (por
exemplo, escutar e transferir só com a chamada em conversa).

## Ramais

![Aba Ramais](../img/ramais.png)

Cada cartão mostra o ramal, a situação (**Livre**, **Em uso**, **Ocupado**, **Tocando**, **Em
espera**, **Indisponível**) e o aparelho registrado. Use os filtros **Todos / Livres / Em uso /
Indisponíveis** e a busca para encontrar um ramal.

O botão **Ligar** faz o ramal tocar; quando a pessoa atende, o painel liga para o número que você
informou — útil para retornar uma ligação pelo ramal certo.

## Filas

![Aba Filas](../img/filas.png)

Cada fila mostra:

- **Aguardando**, com a lista de clientes na ordem de atendimento e o tempo de espera de cada um.
  A espera fica **amarela a partir de 1 minuto** e **vermelha a partir de 3 minutos**;
- **Atendidas**, **Abandonadas**, **Espera média**, **Conversa média** e o **Nível de serviço**
  (porcentagem atendida dentro do tempo configurado na fila);
- **Membros** (atendentes): disponíveis, em atendimento, em pausa (com o motivo e há quanto
  tempo) e indisponíveis. Membros marcados como **dinâmico** foram adicionados pelo painel e não
  fazem parte do cadastro da fila.

### Ações de um membro — menu ⋮

![Menu de ações de um membro de fila](../img/menu-membro.png)

- **Pausar / Retomar** — com motivo opcional (ex.: "Almoço") e a opção de aplicar em **todas as
  filas** do atendente.
- **Alterar penalidade** — quanto maior a penalidade, mais tarde o atendente recebe chamadas
  (0 = recebe primeiro). Em membros do cadastro, a penalidade volta ao valor original quando as
  filas são recarregadas.
- **Remover da fila** — só para membros **dinâmicos**. Membros do cadastro saem pelo cadastro de
  filas (no AzCall) ou podem ser pausados.

### Adicionar um atendente

O botão **Adicionar** no cartão da fila coloca um ramal na fila na hora — por exemplo, para
reforçar o atendimento num pico. Escolha o ramal, a penalidade e se ele já entra pausado.

![Adicionar membro à fila](../img/adicionar-membro.png)

O ramal entra como **dinâmico**: continua na fila (inclusive depois de reiniciar o PBX) até ser
removido pelo painel.

### Previsão

Cada fila tem um bloco **Previsão**, que olha para os **próximos minutos** em vez do que já
aconteceu. Ele usa o ritmo de chegada de ligações dos últimos 15 minutos, o tempo médio de
atendimento e os atendentes disponíveis agora.

![Bloco Previsão de uma fila](../img/previsao.png)

- **Selo**: **Dentro da meta** (verde), **Abaixo da meta** (amarelo), **Vai estourar**
  (vermelho) ou **Sem movimento** (nenhuma ligação na janela).
- **Previsto X% · meta 80% em 20 s**: quantas ligações devem ser atendidas dentro do tempo da
  meta, se nada mudar. O tempo vem do nível de serviço configurado na fila.
- **Precisa de N atendentes, tem M**: quantos atendentes livres seriam necessários para cumprir a
  meta.
- **Entrada** (ligações por minuto, com a seta de tendência) e **atendimento médio**. Antes do
  primeiro atendimento terminar, o atendimento médio é uma **estimativa inicial** (3 min).
- Na lista de quem aguarda, **atende ~X min** estima quando cada cliente deve ser atendido.

Logo depois que o painel começa a monitorar, a previsão aparece com o aviso **Coletando dados**
até completar a primeira janela.

### Sugestões

Para quem pode pausar ou gerenciar membros de fila, as abas **Visão geral** e **Filas** mostram o
cartão **Sugestões**: o painel aponta o que fazer quando uma fila corre risco.

![Cartão Sugestões](../img/sugestoes.png)

- **Fila em risco** (abaixo da meta, vai estourar ou cliente esperando sem atendente livre):
  sugere **Retomar** quem está em pausa nessa fila (há mais tempo primeiro) e **Adicionar** ramais
  livres que ainda não são da fila. Cada ramal é sugerido para uma fila só, começando pela mais
  grave.
- **Pausa longa**: avisa quem está em pausa há 30 minutos ou mais, mesmo sem risco.
- Os botões abrem a **mesma confirmação** das outras ações: nada é feito sem você confirmar.
- O **×** dispensa a sugestão por 10 minutos.
- A **engrenagem** ajusta o tempo da pausa longa (0 desliga o aviso) e os motivos de pausa que não
  devem gerar aviso (ex.: "Treinamento"). A escolha fica salva neste navegador.

Só aparecem sugestões que você tem permissão para executar: **Retomar** exige "Pausar membros de
fila"; **Adicionar**, "Adicionar/remover membros de fila".

## Alertas de desconexão

Avisam quando um ramal ou tronco **que estava online** fica fora do ar — por exemplo, um
telefone que perdeu a rede ou a operadora que caiu.

![Seção Desconectados](../img/desconectados.png)

- Clique no **sino** ao lado do selo de conexão e marque **Ativar alertas de desconexão**.
- Quando alguém cai, aparece a seção **Desconectados** no topo da Visão geral e da aba Ramais,
  com há quanto tempo está fora e quantos alertas já tocaram. O sino mostra quantos estão em
  alerta. Quando volta ao ar, sai da lista sozinho.
- **Troncos** aparecem primeiro e em vermelho: sem eles, ninguém liga para fora.
- Ramais que **já estavam offline** quando o painel começou a monitorar (ex.: aparelho ainda não
  instalado) não geram alerta; ficam numa linha recolhida.

![Configuração dos alertas](../img/alertas.png)

| Opção                        | O que faz                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **Tocar som**                | bipe a cada alerta (três bipes quando é um tronco); **testar** toca um bipe    |
| **Notificação do navegador** | aviso do sistema mesmo com a aba em segundo plano (o navegador pede permissão) |
| **Enquanto continuar fora**  | repete o alerta a cada 1, 2, 5, 10 ou 15 minutos (ou não repete)               |
| **Tolerância**               | quedas mais curtas que isso não avisam (padrão 30 s), evitando alarme falso    |
| **Vigiar**                   | todos os ramais e troncos, ou só os escolhidos                                 |

As configurações valem para o navegador onde foram feitas. Os alertas só tocam enquanto o
painel estiver aberto. No **modo TV**, a tela **Desconectados** entra no rodízio sempre que há
alguém fora do ar.

## Modo TV

Para deixar numa TV da operação: tela escura, letras grandes e nenhuma ação.

- **No AzCall:** botão **Modo TV** na página do AstCall (abre em nova aba).
- **No standalone:** botão **Modo TV** na barra superior.

| Filas                                  | Chamadas e ramais                            |
| -------------------------------------- | -------------------------------------------- |
| ![Modo TV, filas](../img/tv-filas.png) | ![Modo TV, chamadas](../img/tv-chamadas.png) |

- **Rodízio:** alterna entre Filas e Chamadas (e Desconectados, quando há alguém fora do ar) a
  cada 15 segundos. O botão **Rodízio
  ligado/desligado** fixa a tela atual; a escolha fica salva no navegador da TV.
- **Tela cheia:** botão **Tela cheia** (o navegador pede um clique).
- Os botões somem quando o mouse fica parado e voltam ao mexer.
- Na tela de filas, uma faixa colorida à esquerda destaca a fila com espera longa.

## Permissões

O que cada pessoa pode fazer é definido pelo administrador (no AzCall: **Funções & Permissões**;
no standalone: tela **Usuários**). Sem permissão, o botão simplesmente não aparece — e o servidor
também recusa.

| Permissão (AzCall)     | Permissão (standalone)            | Libera                                         |
| ---------------------- | --------------------------------- | ---------------------------------------------- |
| `astcall.view`         | Ver o painel                      | ver o painel e o modo TV                       |
| `astcall.originate`    | Ligar a partir de um ramal        | botão **Ligar** dos ramais                     |
| `astcall.hangup`       | Desligar chamadas                 | **Desligar**                                   |
| `astcall.transfer`     | Transferir chamadas               | **Transferir**                                 |
| `astcall.spy`          | Escutar / sussurrar / intervir    | **Escutar**                                    |
| `astcall.queue`        | Pausar membros de fila            | **Pausar / Retomar**, cartão **Sugestões**     |
| `astcall.queue_manage` | Adicionar/remover membros de fila | **Adicionar**, **Remover da fila**, penalidade |
| —                      | Gerenciar usuários                | tela **Usuários** (só no standalone)           |

Mudanças de permissão valem em até 10 minutos (na próxima renovação automática do acesso) ou ao
entrar novamente.

## Usuários (standalone)

Quem tem a permissão **Gerenciar usuários** vê o link **Usuários** na barra superior: cria
usuários, ajusta permissões, troca senhas, desativa e remove.

![Tela de usuários](../img/usuarios.png)

- A senha tem no mínimo 10 caracteres.
- Trocar a senha ou desativar um usuário encerra na hora as sessões abertas dele.
- Ninguém consegue desativar ou remover a si mesmo, e sempre sobra ao menos um administrador.

## Dúvidas frequentes

**Uma chamada que já terminou continua aparecendo.** O painel confere o estado com o PBX a cada
minuto e remove o que sobrou; se persistir, recarregue a página.

**Não vejo um ramal ou uma fila.** No AzCall, você vê só o que é da sua empresa. Confira também os
filtros e a busca.

**O botão de uma ação não aparece.** Falta a permissão correspondente (tabela acima) ou a ação não
se aplica à situação da chamada.

**"Sessão expirada".** Entre novamente. No AzCall, a página volta sozinha para o login.

**Toda ação fica registrada?** Sim: quem fez, quando, o quê e o resultado ficam no log de
auditoria do servidor.
