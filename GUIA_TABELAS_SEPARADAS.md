# Guia: Tabelas Separadas - Vendas vs Solicitações

## Estrutura Recomendada

### Tabela 1: "Shopify" (Vendas)
- **Uso**: Registros de pedidos vindos do Shopify
- **Fonte**: Webhook do Shopify (`/webhook/orders/create`)
- **Status**: ✅ Já configurado e funcionando

### Tabela 2: "Solicitações Tabela de Valores" (ou nome que preferir)
- **Uso**: Solicitações de veterinários interessados em receber tabela de preços
- **Fonte**: Formulário do site
- **Status**: ⚠️ Precisa ser criada e configurada

---

## Passo a Passo

### 1. Criar Nova Tabela no Airtable

1. No Airtable, clique no botão **"+"** ao lado da aba "Shopify"
2. Escolha **"Create a new table"**
3. Nomeie como: **"Solicitações Tabela de Valores"** (ou outro nome de sua preferência)

### 2. Configurar Campos da Nova Tabela

Crie os campos necessários para capturar as informações do formulário. Exemplo:

- **Nome** (Text)
- **Sobrenome** (Text)
- **Email** (Email)
- **Telefone** (Phone number)
- **Nome da Clínica ou Hospital** (Text)
- **CRMV** (Text) - opcional
- **Data da Solicitação** (Date)
- **Status** (Single select) - ex: "Pendente", "Enviado", "Respondido"
- **Observações** (Long text) - opcional

### 3. Configurar o Formulário do Site

O formulário precisa fazer uma requisição POST para a API do Airtable salvando na nova tabela.

**Endpoint do Airtable:**
```
POST https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/Solicitações Tabela de Valores
```

**Exemplo de payload:**
```json
{
  "records": [
    {
      "fields": {
        "Nome": "João",
        "Sobrenome": "Silva",
        "Email": "joao@clinica.com",
        "Telefone": "+5511999999999",
        "Nome da Clínica ou Hospital": "Clínica Veterinária XYZ",
        "Data da Solicitação": "2025-11-18",
        "Status": "Pendente"
      }
    }
  ]
}
```

### 4. Opções para o Formulário

#### Opção A: Formulário direto no Airtable
- Use o recurso **"Forms"** do próprio Airtable
- Crie um formulário público que salva diretamente na nova tabela
- Mais simples, mas menos customizável

#### Opção B: Formulário no site + API
- Formulário HTML/React no seu site
- Backend que recebe os dados e salva no Airtable via API
- Mais controle sobre validação e UX

#### Opção C: Webhook do Airtable
- Configure um webhook no Airtable que notifica quando há nova solicitação
- Útil para automações e notificações

---

## Vantagens da Separação

✅ **Organização**: Vendas e solicitações ficam separadas  
✅ **Filtros**: Mais fácil filtrar e buscar informações  
✅ **Relatórios**: Relatórios específicos para cada tipo  
✅ **Permissões**: Pode dar permissões diferentes para cada tabela  
✅ **Automações**: Automações específicas para cada fluxo  

---

## Campos Comuns vs Específicos

### Campos que podem ser iguais nas duas tabelas:
- Nome
- Sobrenome
- Email
- Telefone
- Nome da Clínica ou Hospital
- CRMV

### Campos específicos da tabela "Shopify":
- Pedido (# Pedido)
- Data da Compra
- Endereço completo
- CEP, Cidade, Estado
- TAG (Veterinário, Criador, Tutor)
- Teste (tipo de teste genético)
- Status de Pagamento

### Campos específicos da tabela "Solicitações":
- Data da Solicitação
- Status da Solicitação
- Observações
- Método de Contato Preferido (opcional)

---

## Próximos Passos

1. ✅ Código do Shopify já está funcionando
2. ⏳ Criar nova tabela no Airtable
3. ⏳ Configurar campos da nova tabela
4. ⏳ Ajustar formulário do site para salvar na nova tabela
5. ⏳ Testar fluxo completo

---

## Suporte

Se precisar de ajuda para configurar o formulário ou a integração com a nova tabela, me avise!

