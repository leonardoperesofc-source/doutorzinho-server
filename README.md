# Doutorzinho Server

Servidor do WhatsApp do Doutorzinho — integração Z-API + Claude API.

## Como subir no Vercel (passo a passo)

### 1. Criar repositório no GitHub
- Acessa github.com → New repository → nome: `doutorzinho-server`
- Faz upload de todos os arquivos desta pasta

### 2. Importar no Vercel
- Acessa vercel.com → Add New Project
- Conecta o repositório `doutorzinho-server`
- Clica em Deploy

### 3. Configurar variáveis de ambiente no Vercel
Vai em Settings → Environment Variables e adiciona:

| Nome | Valor |
|------|-------|
| CLAUDE_API_KEY | sua chave da Claude API |
| ZAPI_INSTANCE_ID | 3F0FB3E6FACC91802BBCBA665B49BD70 |
| ZAPI_TOKEN | BCB477126FD7EA44F248F57B |
| ZAPI_SECURITY_TOKEN | seu security token do Z-API |

### 4. Pegar a URL do servidor
Após o deploy, o Vercel te dá uma URL tipo:
`https://doutorzinho-server.vercel.app`

Sua URL do webhook será:
`https://doutorzinho-server.vercel.app/api/webhook`

### 5. Configurar webhook no Z-API
- Acessa o painel do Z-API
- Vai em Webhooks → On Message Received
- Cola a URL: `https://doutorzinho-server.vercel.app/api/webhook`
- Salva

### 6. Adicionar assinantes
No arquivo `api/webhook.js`, na linha do `ASSINANTES`, adiciona o número
do cliente após cada pagamento confirmado:

```js
const ASSINANTES = new Set([
  "5511999999999", // João Silva
  "5521988888888", // Maria Costa
]);
```

Cada vez que adicionar um assinante, faz um novo deploy no Vercel.

## Como funciona

1. Cliente manda foto no WhatsApp do Doutorzinho
2. Z-API recebe e chama o webhook (sua URL)
3. Servidor verifica se o número é assinante
4. Se sim → manda para Claude API analisar
5. Claude retorna a análise do Doutorzinho
6. Servidor manda a resposta de volta via Z-API
7. Cliente recebe no WhatsApp em ~30 segundos
