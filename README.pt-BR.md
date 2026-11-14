# Booksy MCP

Servidor [MCP](https://modelcontextprotocol.io) e [Agent Plugin](https://agent-plugins.org) não oficiais para a API de cliente da Booksy no Brasil (`br.booksy.com`). Permite buscar estabelecimentos, listar serviços e equipe, consultar horários livres e — com um token de acesso do cliente que você mesmo fornece — listar, pré-visualizar, confirmar ou cancelar agendamentos.

## Aviso

Este é um projeto comunitário, não oficial. **Não é afiliado, endossado ou suportado pela Booksy**. Ele usa a **API web de cliente da Booksy, que não é documentada** e pode quebrar ou mudar sem aviso. Use por sua conta e risco, e respeite os [Termos de Serviço da Booksy](https://booksy.com/pt-br/p/terms).

A cobertura é apenas o Brasil. A variável de ambiente `BOOKSY_COUNTRY` existe, mas só o valor `br` foi testado.

## Setup em um clique para agentes

Clique no ícone de copiar do bloco abaixo e cole no seu agente de programação, como Cursor, Claude Code, Codex ou OpenCode.

```text
Set up Booksy Brazil MCP for my coding agent on this machine.

1. Clone https://github.com/p4cs-974/booksy-mcp into a suitable local directory, or reuse an existing clone without overwriting local changes. Read its README.md and skills/booksy/SKILL.md. Verify Node.js 18 or later is available. There are no npm dependencies to install. Run the server with node server.mjs.

2. Add a stdio MCP server named booksy to this agent's MCP configuration, preserving existing entries. Use command "node" and args ["/absolute/path/to/server.mjs"], replacing the path with the actual absolute path in the clone. For Cursor, .cursor/mcp.json is one option; use the equivalent configuration for other clients. The repository's mcp.json uses args ["./server.mjs"] and cwd "${PLUGIN_ROOT}" for clients implementing Agent Plugins 1.0.0. Do not assume that variable works in a normal MCP configuration.

3. If this agent supports skills, install skills/booksy/SKILL.md using its supported skill installation mechanism.

4. Ask me for a Booksy customer access token through a secure input mechanism, never ordinary chat. Prefer storing it outside the repo at ~/.config/booksy/token with mode 600. Alternatively, use BOOKSY_ACCESS_TOKEN in the server's environment. Never hardcode the token or write it into chat logs, issues, or the repo. If secure input is unavailable, ask me to create the token file locally. Token lookup order is non-empty BOOKSY_ACCESS_TOKEN, otherwise the file at BOOKSY_TOKEN_FILE if set, otherwise ~/.config/booksy/token. Email/password login is unsupported. If I need help, point me to "Getting a customer access token" in README.md to copy x-access-token from my existing browser session. Do not scrape the token.

5. Reload the MCP client if needed. Verify by calling search_businesses with {"query":"barbearia"}; query is required and location is optional. search_businesses, get_business, and get_free_slots work without a token, so run this check even if I skip token setup. Account tools require a token. Do not call create_booking or cancel_booking during setup.

Report the configuration and skill paths, verification result, and any remaining steps without revealing secrets.
```

## Requisitos

- **Node.js 18 ou posterior** (o servidor usa a API global `fetch` e `AbortSignal.timeout`)
- **Nenhuma dependência npm** — execute `node server.mjs` diretamente

## Instalação

Clone ou copie este diretório para algum lugar da sua máquina. Nos trechos abaixo, troque `/path/to/server.mjs` pelo caminho absoluto do `server.mjs` nessa cópia.

As ferramentas de conta também precisam de um token de acesso do cliente (veja [Como obter o token de acesso](#como-obter-o-token-de-acesso)). Busca e disponibilidade funcionam sem token.

### Cursor

**Pasta de plugin local.** Copie este diretório para `~/.cursor/plugins/local/booksy` (um diretório real, não um atalho simbólico) e recarregue a janela.

**Ou** adicione o servidor em `.cursor/mcp.json` (do projeto) ou na configuração MCP do usuário no Cursor:

```json
{
  "mcpServers": {
    "booksy": {
      "command": "node",
      "args": ["/path/to/server.mjs"]
    }
  }
}
```

O `mcp.json` do próprio plugin usa o caminho relativo `./server.mjs` e `cwd: "${PLUGIN_ROOT}"`, como exige o schema Agent Plugins 1.0.0. Clientes que implementam esse schema definem `PLUGIN_ROOT` para você. O carregador de plugins do Cursor pode usar outra variável (`${CURSOR_PLUGIN_ROOT}`) e pode não expandir `${PLUGIN_ROOT}`; se a instalação local do plugin não iniciar, execute `node ./server.mjs` com o diretório do plugin como diretório de trabalho, ou use o trecho de `.cursor/mcp.json` acima com um caminho concreto.

### Claude Desktop

Inclua o servidor no `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "booksy": {
      "command": "node",
      "args": ["/path/to/server.mjs"]
    }
  }
}
```

Reinicie o Claude Desktop depois de salvar.

### Grok Bot

Adicione um servidor MCP personalizado com este comando:

```text
node /path/to/server.mjs
```

### Outros clientes MCP via stdio

O servidor fala JSON-RPC 2.0 em stdin/stdout (JSON delimitado por linha, ou framing `Content-Length`). Aponte o cliente para:

```text
node /path/to/server.mjs
```

Se o cliente aceitar um mapa `env` na entrada do servidor, você pode definir `BOOKSY_ACCESS_TOKEN` ali. É preferível usar o arquivo de token (abaixo) para o valor não acabar num arquivo de configuração que você possa versionar. Não coloque tokens neste repositório.

## Ferramentas de leitura (sem login)

`search_businesses`, `get_business` e `get_free_slots` usam a `x-api-key` pública do marketplace da Booksy. Não é preciso ter conta.

Se `BOOKSY_API_KEY` não estiver definida, o servidor coleta a chave `web-*` de produção a partir dos arquivos JavaScript do booksy.com em tempo de execução e a guarda em cache num arquivo temporário por 24 horas. Você pode definir `BOOKSY_API_KEY` para pular essa coleta. Nunca imprima, versione ou cole essa chave.

## Como obter o token de acesso

O login com e-mail e senha não é suportado: a Booksy exige um token hCaptcha em `POST /core/v2/customer_api/account/login`. As ferramentas de conta usam então um token de sessão que você copia de um login que já fez no navegador.

O app web do marketplace guarda o token num cookie chamado `identity-br` (`identity-` mais o código do país), com `max-age` de 31536000 segundos (365 dias), `path=/`, `Secure` e `SameSite=Lax`. No login, o app grava **apenas a string crua do token** nesse cookie — não o objeto completo `{ accessToken, profile }` que ele mantém em memória.

O helper de cookie aplica `encodeURIComponent` ao valor. Num token típico (letras e dígitos, sem pontuação), a forma codificada é idêntica ao token cru. O helper só envolve o valor em JSON antes quando ele não é uma string simples, ou quando a string em si é um JSON que não é string (por exemplo um objeto). Na leitura, o app faz `decodeURIComponent` e depois tenta `JSON.parse`.

**A aba Rede (Network) é o jeito mais confiável de obter o token cru**, porque `x-access-token` é o cabeçalho que a API de fato usa.

### 1. Entre na conta

Abra o [booksy.com](https://booksy.com/pt-br/), entre com sua conta de cliente e permaneça no site.

### 2. Copie o token

**Chrome ou Edge (recomendado: Rede)**

1. Pressione F12 (ou clique com o botão direito na página → Inspecionar).
2. Abra a aba **Rede** (**Network**). Filtre por `customer_api/me`.
3. Clique numa requisição para `/core/v2/customer_api/me` (recarregue a página se não aparecer nenhuma).
4. Em **Cabeçalhos da requisição** (**Request Headers**), copie o valor de `x-access-token`. Esse é o token cru.

**Chrome ou Edge (Cookies)**

1. Pressione F12 → **Aplicativo** (**Application**) → **Cookies** → `https://booksy.com`.
2. Selecione o cookie `identity-br`.
3. Copie o valor e então:
   - Se for um token simples (sem sequências `%`, aspas em volta ou `{...}`), use-o como está. Esse é o caso usual.
   - Se parecer URL-encoded (`%22`, `%7B` etc.), decodifique primeiro. No console do DevTools: `decodeURIComponent("cole-o-valor-do-cookie")`.
   - Se o valor decodificado for JSON do tipo `{"accessToken":"..."}`, use o campo `accessToken`.
   - Se o valor decodificado for uma string JSON entre aspas (começa e termina com `"`), faça o parse: `JSON.parse("cole-o-valor-decodificado")`. O resultado é o token cru.

**Firefox**

1. Abra as ferramentas de desenvolvedor (F12) → **Armazenamento** (**Storage**) → **Cookies** → `https://booksy.com`.
2. Selecione `identity-br` e extraia o token cru com as mesmas regras acima.
3. Ou use a aba Rede, filtre `customer_api/me` e copie `x-access-token` nos cabeçalhos da requisição.

**Safari**

1. Ative o menu Desenvolver: Safari → Ajustes → Avançado → “Mostrar funcionalidades para desenvolvedores web” (em versões mais antigas, “Mostrar menu Desenvolver na barra de menus”).
2. Desenvolver → Mostrar Inspetor Web → **Armazenamento** (**Storage**) → **Cookies**.
3. Selecione `identity-br` em `https://booksy.com` e extraia o token cru com as mesmas regras acima.
4. Ou use a aba Rede e copie `x-access-token` de uma requisição `customer_api/me`.

Não versione o token e não o cole em chats ou issues.

### 3. Onde guardar

O servidor consulta, nesta ordem:

1. **`BOOKSY_ACCESS_TOKEN`** no ambiente (vence se estiver definida e não vazia)
2. **`BOOKSY_TOKEN_FILE`**, se você quiser um caminho personalizado
3. Caso contrário, **`~/.config/booksy/token`**

O arquivo é relido a cada chamada, então você pode trocar o token sem reiniciar o servidor.

```bash
mkdir -p ~/.config/booksy
# cole apenas o token cru, sem aspas nem envelope JSON, e então:
chmod 600 ~/.config/booksy/token
```

### Validade e rotação

O cookie `identity-br` é emitido com max-age de cerca de **365 dias**. **Não há endpoint de refresh**. Sair da conta na Booksy pode revogar o token. Quando ele deixar de funcionar, entre de novo, copie um token novo, substitua a variável de ambiente ou o arquivo, e apague o valor antigo.

Trate o token como uma senha. Quem o tiver pode agir em seu nome na Booksy (listar, agendar, cancelar). Nunca o versione, nunca o cole em chats ou issues do GitHub, e evite deixá-lo no `mcp.json` ou no histórico do shell.

## Fingerprint (opcional)

O widget oficial de agendamento sempre envia um cabeçalho `X-Fingerprint` (um UUID, guardado no cookie `_bf` do widget). Este servidor faz o mesmo:

- `BOOKSY_FINGERPRINT`, se estiver definida
- senão `BOOKSY_FINGERPRINT_FILE`, ou `~/.config/booksy/fingerprint`
- senão ele gera um UUID e tenta gravá-lo nesse caminho

Em geral você não precisa configurar isso.

## Outras variáveis de ambiente

| Variável | Padrão | Função |
| --- | --- | --- |
| `BOOKSY_COUNTRY` | `br` | Host da API `{country}.booksy.com`. Só `br` foi testado. |
| `BOOKSY_LOCALE` | `pt-BR` | `Accept-Language` |
| `BOOKSY_API_KEY` | (coletada) | Substitui a chave pública do marketplace |
| `BOOKSY_CACHE_DIR` | um diretório temporário | Onde fica o cache da chave coletada |
| `BOOKSY_FETCH_KEY` | (ligado) | Defina como `0` para desligar a coleta no JS |
| `BOOKSY_APP_VERSION` | `1.213.0` | Enviado como `X-App-Version` / `meta.app_version` (formato do widget) |
| `BOOKSY_UA` | um UA de Chrome para desktop | `User-Agent` HTTP |

O schema de manifesto Agent Plugins 1.0.0 não tem campo `variables`, e o `env` do `mcp.json` não expande placeholders `${ENV}` arbitrários, então isso não é declarado nos manifestos. Defina as variáveis no ambiente herdado pelo processo.

## Ferramentas

As ferramentas de escrita (`create_booking`, `cancel_booking`) precisam ser **confirmadas com o usuário** antes de serem chamadas.

### `search_businesses`

Sem autenticação. Busca estabelecimentos Booksy no Brasil.

- `query` (string, obrigatório) — nome do salão ou palavras-chave
- `location` (string, opcional) — cidade ou local (resolvido primeiro para um id de localização)

Devolve objetos compactos `BusinessSummary`: `id`, `name`, `address`, `city`, `rating`, `reviews_count`, `url`.

### `get_business`

Sem autenticação. Detalhes de um estabelecimento.

- `business_id` (obrigatório) — id vindo de `search_businesses`

Devolve `BusinessDetail`: endereço, `services` (cada um com `variants`: `variant_id`, `price`, `duration_min`) e `staff` (`staffer_id`, `name`).

### `get_free_slots`

Sem autenticação. Horários de início livres para um serviço numa data.

- `business_id` (obrigatório)
- `service_variant_id` (obrigatório) — vindo de `get_business`
- `date` (obrigatório) — `YYYY-MM-DD`
- `staffer_id` (opcional) — filtrado no cliente; a consulta no servidor não reduz o payload

Devolve `DaySlots` com horários `HH:MM`. A disponibilidade pode mudar antes do agendamento; trate isso como um retrato do momento.

### `list_my_bookings`

Exige token de acesso do cliente. Lista os agendamentos da conta conectada.

- `state` (opcional) — `active` (próximos) ou `inactive` (encerrados). Também aceita `upcoming` e `finished` / `past`.
- `page` (opcional, padrão 1)
- `per_page` (opcional, padrão 20)

Devolve objetos compactos de agendamento (`appointment_uid`, `booked_from`, `status`, estabelecimento, serviço, profissional, `total`).

### `create_booking`

**ESCRITA.** Confirme com o usuário o estabelecimento, o serviço, o profissional, a data e o horário antes de chamar.

- `business_id` (obrigatório)
- `service_variant_id` (obrigatório)
- `staffer_id` (obrigatório)
- `date` (obrigatório) — `YYYY-MM-DD`
- `time` (obrigatório) — `HH:MM`
- `dry_run` (opcional, **padrão `true`**)

Com `dry_run` igual a `true` (o padrão), o servidor cria um **rascunho temporário**, define serviço, profissional e horário, e devolve a pré-visualização de confirmação (`GET /drafts/{id}/confirmation`). Ele **não** chama `/schedule`, então nenhum agendamento é confirmado. Com `dry_run` igual a `false`, ele segue para `POST /drafts/{id}/schedule` e confirma um agendamento de verdade.

Mantenha `dry_run=true` até o usuário ver a prévia e pedir explicitamente para agendar. Só então chame de novo com os mesmos argumentos e `dry_run=false`.

### `cancel_booking`

**ESCRITA, destrutiva.** Confirme com o usuário antes. Isso cancela um agendamento real e não pode ser desfeito por este plugin.

- `appointment_id` (obrigatório) — o `appointment_uid` de `list_my_bookings`

## Limites

- Não há login com e-mail e senha (o endpoint exige hCaptcha).
- Os horários de `get_free_slots` são ao vivo e podem desaparecer antes do `create_booking`.
- Seja comedido no volume de requisições; isto é um cliente de automação pessoal, não um coletor em massa.
- Agendamentos feitos por este plugin são atribuídos com `booking_source` **Other_Integration**.
- A API não é documentada e pode mudar. O Brasil (`br`) é a única região testada.

## Exemplo (ids de um estabelecimento público)

Os ids abaixo vêm de uma listagem **pública** da Booksy e aparecem só como exemplo. Não são uma recomendação e podem mudar. Sempre busque e leia o estabelecimento ao vivo antes de agendar.

Exemplo de estabelecimento: **Brabo Barbearia**, `business_id` `103441` (São Caetano do Sul).

1. `search_businesses` com `query` `"Brabo Barbearia"` e `location` `"São Caetano do Sul"`
2. `get_business` com `business_id` `103441`
3. `get_free_slots` com esse `business_id`, um `service_variant_id` do salão (exemplo: `1421878` para o Combo), uma data como `2026-11-20` e, se quiser, um `staffer_id` (exemplo: `230915`)
4. `create_booking` com os mesmos ids, data e horário (exemplo: `"14:00"`), deixando `dry_run` verdadeiro
5. Só depois de o usuário aprovar a prévia, chame `create_booking` de novo com `dry_run=false`

## Licença

MIT. Veja [LICENSE](./LICENSE).
