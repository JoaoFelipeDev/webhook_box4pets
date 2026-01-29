import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Função opcional para validar o webhook do Shopify
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const generatedHmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(hmacHeader || "", "utf8"),
    Buffer.from(generatedHmac, "utf8")
  );
}

app.post("/webhook/orders/create", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.warn("❌ Webhook não verificado (HMAC inválido)");
      return res.status(401).send("Webhook não verificado");
    }

    const order = req.body;
    console.log("✅ Pedido recebido:", order);
    console.log("📅 Data do pedido:", order.created_at);
    console.log("💳 Status do pagamento:", order.financial_status);
    console.log("📋 Número do pedido:", order.order_number);
    console.log("💰 Total:", order.total_price);

    const customer = order.customer || {};

    console.log("📦 Processando cliente:", customer);
    console.log("🏥 Endereço de envio:", order.shipping_address);
    console.log("🏥 Endereço de cobrança:", order.billing_address);

    // Dados do cliente vindos do pedido Shopify
    const shippingAddress = order.shipping_address || {};
    const billingAddress = order.billing_address || {};
    const firstAddress = shippingAddress.address1 ? shippingAddress : billingAddress;

    // Concatena endereço completo (address1 + address2)
    const enderecoCompleto = [
      firstAddress.address1 || "",
      firstAddress.address2 || ""
    ].filter(Boolean).join(", ").trim();

    // Busca o nome da clínica/hospital em múltiplos lugares
    const nomeClinicaHospital =
      shippingAddress.company ||
      billingAddress.company ||
      customer.note ||
      "";

    // Busca telefone em múltiplos lugares
    const telefone =
      firstAddress.phone ||
      customer.phone ||
      order.phone ||
      "";

    // Função para converter status de pagamento para português
    // Campo é do tipo texto no Airtable, então pode receber qualquer valor
    function traduzirStatusPagamento(financialStatus) {
      const statusMap = {
        "pending": "Pendente",
        "paid": "Pago",
        "authorized": "Autorizado", // Autorizado = já foi aprovado
        "partially_paid": "Parcialmente Pago", // Parcialmente pago
        "refunded": "Reembolsado", // Reembolsado
        "voided": "Cancelado", // Cancelado
        "partially_refunded": "Parcialmente Reembolsado" // Parcialmente reembolsado
      };
      // Retorna o status traduzido ou o status original se não estiver no mapa
      return statusMap[financialStatus] || financialStatus || "Pendente";
    }

    // Função para formatar data para o Airtable
    // Tenta diferentes formatos: apenas data (YYYY-MM-DD) ou data com hora (ISO 8601)
    function formatarDataParaAirtable(dateString) {
      if (!dateString) return "";
      try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return "";

        // Tenta primeiro apenas a data (YYYY-MM-DD) - formato mais comum para campos de data simples
        const ano = date.getFullYear();
        const mes = String(date.getMonth() + 1).padStart(2, '0');
        const dia = String(date.getDate()).padStart(2, '0');
        const apenasData = `${ano}-${mes}-${dia}`;

        // Retorna apenas a data (sem hora) - mais compatível com campos de data simples no Airtable
        return apenasData;
      } catch (e) {
        console.warn("⚠️ Erro ao formatar data:", dateString, e);
        return dateString; // Retorna o original se não conseguir formatar
      }
    }

    // Função para remover campos vazios (especialmente importante para campos select)
    // Campos de texto podem ser vazios, mas campos select não podem criar novas opções vazias
    function removerCamposVazios(campos) {
      const camposLimpos = {};
      // Lista de campos que podem ser select e não devem ser enviados vazios
      const camposSelectPossiveis = ["Teste", "CRMV", "TAG"];

      for (const [chave, valor] of Object.entries(campos)) {
        // Se for um campo select possível e estiver vazio, não inclui
        if (camposSelectPossiveis.includes(chave) && (valor === "" || valor === null || valor === undefined)) {
          continue;
        }
        // Para outros campos, remove apenas se for null ou undefined (mantém string vazia para campos de texto)
        if (valor !== null && valor !== undefined) {
          camposLimpos[chave] = valor;
        }
      }
      return camposLimpos;
    }

    // Formata a data para o Airtable
    const dataFormatada = formatarDataParaAirtable(order.created_at);

    // Função para verificar e extrair tag válida do pedido
    function obterTagValida(order) {
      const tagsValidas = ["Veterinário", "Criador", "Tutor"];

      // Verifica tags do pedido (order.tags pode ser string separada por vírgulas)
      if (order.tags) {
        const tagsArray = order.tags.split(",").map(tag => tag.trim());
        for (const tag of tagsArray) {
          if (tagsValidas.includes(tag)) {
            return tag;
          }
        }
      }

      // Se não encontrou tag válida, retorna null
      return null;
    }

    // Lista de testes válidos e mapeamento por padrão (usado por obterTesteValido e obterTesteDeItem)
    const testesValidos = [
      "Saúde - Identificação de Doenças Genéticas",
      "Origem - Identificação de Raças",
      "Painel Saúde + Painel Origem",
      "Perfil de SNP/DNA (Teste de Paternidade)",
      "Teste Genético ALKC RI (registro inicial): Identificação de Raça - Origem",
      "Teste Genético ALKC: Identificação de Doenças, Traços e Perfil de DNA"
    ];
    const mapeamentoTestes = [
      { padrao: /alkc\s+ri|registro\s+inicial/i, teste: "Teste Genético ALKC RI (registro inicial): Identificação de Raça - Origem" },
      { padrao: /alkc/i, teste: "Teste Genético ALKC: Identificação de Doenças, Traços e Perfil de DNA" },
      { padrao: /paternidade|snp\/dna|perfil\s+de\s+snp/i, teste: "Perfil de SNP/DNA (Teste de Paternidade)" },
      { padrao: /painel\s+saúde.*painel\s+origem|painel\s+origem.*painel\s+saúde|ultra.*raças.*doenças|raças.*doenças/i, teste: "Painel Saúde + Painel Origem" },
      { padrao: /saúde.*doenças\s+genéticas|doenças\s+genéticas|avançado.*doenças/i, teste: "Saúde - Identificação de Doenças Genéticas" },
      { padrao: /origem.*raças|identificação\s+de\s+raças/i, teste: "Origem - Identificação de Raças" }
    ];

    function verificarPadroesTeste(texto) {
      if (!texto) return null;
      const textoLower = texto.toLowerCase();
      for (const testeValido of testesValidos) {
        if (textoLower === testeValido.toLowerCase()) return testeValido;
      }
      for (const { padrao, teste } of mapeamentoTestes) {
        if (padrao.test(texto)) return teste;
      }
      return null;
    }

    // Retorna o teste válido para um único item do pedido (nome/variante do produto)
    function obterTesteDeItem(item) {
      const nome = (item.name || item.title || "").trim();
      if (nome) {
        const porNome = verificarPadroesTeste(nome);
        if (porNome) return porNome;
      }
      const variante = (item.variant_title || "").trim();
      if (variante) return verificarPadroesTeste(variante);
      return null;
    }

    // Retorna um único teste para o pedido inteiro (usado quando não há line_items ou como fallback)
    function obterTesteValido(order) {
      if (order.tags) {
        const tagsArray = order.tags.split(",").map(tag => tag.trim());
        for (const tag of tagsArray) {
          const t = verificarPadroesTeste(tag);
          if (t) return t;
        }
      }
      if (order.line_items && order.line_items.length > 0) {
        for (const item of order.line_items) {
          const t = obterTesteDeItem(item);
          if (t) return t;
        }
        const todos = order.line_items.map(i => (i.name || i.title || "").trim()).filter(Boolean).join(" ");
        if (todos) return verificarPadroesTeste(todos);
      }
      return null;
    }

    // Monta os campos base com os nomes exatos da tabela Shopify_Vendas
    // Número do pedido e data: "A Pedido" e "A Data do Pedido"
    const camposBase = {
      Name: customer.first_name || "",  // ✅ Campo confirmado que funciona
      Sobrenome: customer.last_name || "",  // ✅ Campo confirmado que funciona
      Telefone: telefone,  // ✅ Campo confirmado que funciona
      UF: firstAddress.province || ""  // ✅ Campo confirmado que funciona
      // Campos que podem não existir na tabela (serão tentados e removidos se não existirem):
      // Email, Cidade, Endereço, CEP, Nome da Clínica ou Hospital, Data da Compra
    };

    // Adiciona Email apenas se tiver valor (será removido automaticamente se não existir na tabela)
    if (customer.email || order.email) {
      camposBase["Email"] = customer.email || order.email;
    }

    // Adiciona Cidade apenas se tiver valor (será removido automaticamente se não existir na tabela)
    if (firstAddress.city) {
      camposBase["Cidade"] = firstAddress.city;
    }

    // Adiciona campos opcionais apenas se tiverem valor
    if (enderecoCompleto) {
      camposBase["Endereço"] = enderecoCompleto;
    }
    if (firstAddress.zip) {
      camposBase["CEP"] = firstAddress.zip;
    }
    if (nomeClinicaHospital) {
      camposBase["Nome da Clínica ou Hospital"] = nomeClinicaHospital;
    }

    // Adiciona campo TAG apenas se houver uma tag válida no pedido
    const tagValida = obterTagValida(order);
    if (tagValida) {
      camposBase["TAG"] = tagValida;
      console.log(`🏷️ Tag válida encontrada: "${tagValida}"`);
    } else {
      console.log("ℹ️ Nenhuma tag válida encontrada no pedido. Campo TAG não será enviado.");
    }

    // Adiciona número do pedido e data (nomes exatos da tabela Airtable: "A Pedido" e "A Data do Pedido")
    if (order.order_number) {
      camposBase["A Pedido"] = Number(order.order_number) || parseInt(order.order_number, 10);
    }
    if (dataFormatada) {
      camposBase["A Data do Pedido"] = dataFormatada;
    }

    // Adiciona "Status de Pagamento" (campo de texto livre no Airtable)
    camposBase["Status de Pagamento"] = traduzirStatusPagamento(order.financial_status);

    // Um registro no Airtable por item do pedido (cada teste = uma linha), com mesmo número e data
    const registrosParaSalvar = [];
    if (order.line_items && order.line_items.length > 0) {
      for (const item of order.line_items) {
        const teste = obterTesteDeItem(item);
        const campos = { ...camposBase };
        if (teste) {
          campos["Teste"] = teste;
          console.log(`🧪 Item "${item.name || item.title}": teste "${teste}"`);
        }
        registrosParaSalvar.push(campos);
      }
    } else {
      const testeFallback = obterTesteValido(order);
      if (testeFallback) camposBase["Teste"] = testeFallback;
      registrosParaSalvar.push(camposBase);
    }

    // Função recursiva para tentar salvar no Airtable, removendo campos problemáticos automaticamente
    async function tentarSalvarNoAirtable(campos, tentativa = 0, maxTentativas = 10) {
      // Remove campos vazios
      const camposFiltrados = {};
      for (const [chave, valor] of Object.entries(campos)) {
        if (valor !== "" && valor !== null && valor !== undefined) {
          camposFiltrados[chave] = valor;
        }
      }

      if (Object.keys(camposFiltrados).length === 0) {
        throw new Error("Nenhum campo válido para enviar ao Airtable");
      }

      const payload = {
        records: [{ fields: camposFiltrados }]
      };

      if (tentativa === 0) {
        // Log apenas na primeira tentativa
        console.log("📤 Payload para Airtable:", JSON.stringify(payload, null, 2));
        console.log("📅 Data original:", order.created_at);
        console.log("📅 Data formatada:", dataFormatada);
      }

      const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Shopify_Vendas`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.AIRTABLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        return { data, camposEnviados: Object.keys(camposFiltrados) };
      }

      // Se deu erro e ainda temos tentativas, tenta remover campos problemáticos
      if (tentativa < maxTentativas && data.error) {
        const { type, message } = data.error;

        if (type === 'UNKNOWN_FIELD_NAME' || type === 'INVALID_MULTIPLE_CHOICE_OPTIONS' || type === 'INVALID_VALUE_FOR_COLUMN') {
          const campoErro = message.match(/"([^"]+)"/)?.[1];

          if (campoErro && camposFiltrados[campoErro]) {
            console.warn(`⚠️ Removendo campo problemático: "${campoErro}" (erro: ${type})`);

            // Remove o campo que causou o erro
            const camposSemErro = { ...camposFiltrados };
            delete camposSemErro[campoErro];

            // Tenta novamente sem esse campo
            return await tentarSalvarNoAirtable(camposSemErro, tentativa + 1, maxTentativas);
          }
        }
      }

      // Se chegou aqui, não conseguiu resolver o erro
      throw { data, camposEnviados: Object.keys(camposFiltrados) };
    }

    // Salva um registro no Airtable por item do pedido
    try {
      for (let i = 0; i < registrosParaSalvar.length; i++) {
        const camposLimpos = removerCamposVazios(registrosParaSalvar[i]);
        const resultado = await tentarSalvarNoAirtable(camposLimpos);
        const data = resultado.data;

        console.log(`✅ Registro ${i + 1}/${registrosParaSalvar.length} salvo no Airtable, ID:`, data.records[0].id);
        console.log("📋 Campos salvos:", resultado.camposEnviados.join(", "));

        const camposRemovidos = Object.keys(camposLimpos).filter(campo => !resultado.camposEnviados.includes(campo));
        if (camposRemovidos.length > 0) {
          console.warn("⚠️ Campos removidos (não existem na tabela):", camposRemovidos.join(", "));
        }
      }
      if (registrosParaSalvar.length > 1) {
        console.log(`✅ Pedido #${order.order_number}: ${registrosParaSalvar.length} testes salvos (número e data em todos).`);
      }
      res.status(200).send("OK");
    } catch (err) {
      if (err.data) {
        console.error("❌ Erro ao salvar no Airtable:", JSON.stringify(err.data, null, 2));
        console.error("📋 Campos tentados:", err.camposEnviados);
        return res.status(500).send("Erro ao salvar no Airtable");
      }
      console.error("💥 Erro no webhook:", err);
      res.status(500).send("Erro interno");
    }
  } catch (err) {
    // Catch para o try externo (erros gerais)
    console.error("💥 Erro geral no webhook:", err);
    if (!res.headersSent) {
      res.status(500).send("Erro interno");
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));