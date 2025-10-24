# Deploy no Render - Guia Passo a Passo

## Pré-requisitos
- Conta no Render (https://render.com)
- Código no GitHub
- Suas credenciais do Shopify e Airtable

## Passos para Deploy

### 1. Fazer push dos arquivos para o GitHub
```bash
git add .
git commit -m "Configuração para deploy no Render"
git push origin main
```

### 2. Criar novo Web Service no Render

1. Acesse https://dashboard.render.com
2. Clique em **"New +"** → **"Web Service"**
3. Conecte seu repositório do GitHub
4. Configure:
   - **Name**: shopify-airtable-sync (ou o nome que preferir)
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### 3. Adicionar Variáveis de Ambiente

Na seção **Environment**, adicione:

```
SHOPIFY_WEBHOOK_SECRET=seu_secret_do_shopify
AIRTABLE_API_KEY=sua_api_key_do_airtable
AIRTABLE_BASE_ID=seu_base_id_do_airtable
```

**Onde encontrar cada valor:**

- **SHOPIFY_WEBHOOK_SECRET**:
  - Shopify Admin → Settings → Notifications → Webhooks
  - Copie o "Webhook signing secret"

- **AIRTABLE_API_KEY**:
  - https://airtable.com/account
  - Generate personal access token

- **AIRTABLE_BASE_ID**:
  - Abra sua base no Airtable
  - URL: `https://airtable.com/app**XXXXX**/...`
  - O ID começa com `app`

### 4. Deploy

1. Clique em **"Create Web Service"**
2. Aguarde o deploy (2-3 minutos)
3. Sua URL será: `https://shopify-airtable-sync.onrender.com`

### 5. Configurar Webhook no Shopify

1. Shopify Admin → Settings → Notifications
2. Webhooks → Create webhook
3. Configure:
   - **Event**: Order creation
   - **Format**: JSON
   - **URL**: `https://SEU-APP.onrender.com/webhook/orders/create`
   - **API version**: Mais recente

## Teste

Para testar se está funcionando:

1. Faça um pedido de teste no Shopify
2. Veja os logs no Render Dashboard
3. Verifique se o registro apareceu no Airtable

## Problemas Comuns

### Cold Start (primeiro request demora)
- Normal no plano gratuito
- Primeira chamada pode levar 30-60 segundos
- Depois fica rápido

### Webhook timeout
- Se o Shopify reclamar de timeout, pode ser cold start
- Configure um cron job gratuito para manter o serviço ativo

## Monitoramento

- Logs: Render Dashboard → Seu serviço → Logs
- Métricas: Render Dashboard → Metrics
