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
    // Apenas "Pago" e "Pendente" são opções válidas no Airtable
    function traduzirStatusPagamento(financialStatus) {
      const statusMap = {
        "pending": "Pagamento Pendente",
        "paid": "Pago",
        "authorized": "Pago", // Autorizado = já foi aprovado, considera como pago
        "partially_paid": "Pago", // Parcialmente pago = tem pagamento, considera como pago
        "refunded": "Pagamento Expirado", // Reembolsado = pagamento expirado
        "voided": "Pagamento Expirado", // Cancelado = pagamento expirado
        "partially_refunded": "Pagamento Pendente" // Parcialmente reembolsado = ainda pendente
      };
      // Retorna as opções válidas no Airtable: "Pago", "Pagamento Pendente", ou "Pagamento Expirado"
      return statusMap[financialStatus] || "Pagamento Pendente";
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

    // Função para identificar o tipo de teste válido baseado nos produtos do pedido
    function obterTesteValido(order) {
      const testesValidos = [
        "Saúde - Identificação de Doenças Genéticas",
        "Origem - Identificação de Raças",
        "Painel Saúde + Painel Origem",
        "Perfil de SNP/DNA (Teste de Paternidade)",
        "Teste Genético ALKC RI (registro inicial): Identificação de Raça - Origem",
        "Teste Genético ALKC: Identificação de Doenças, Traços e Perfil de DNA"
      ];

      // Mapeamento de palavras-chave dos produtos para testes válidos
      // Ordem importa: verifica primeiro padrões mais específicos
      const mapeamentoTestes = [
        // Padrões específicos primeiro
        { padrao: /alkc\s+ri|registro\s+inicial/i, teste: "Teste Genético ALKC RI (registro inicial): Identificação de Raça - Origem" },
        { padrao: /alkc/i, teste: "Teste Genético ALKC: Identificação de Doenças, Traços e Perfil de DNA" },
        { padrao: /paternidade|snp\/dna|perfil\s+de\s+snp/i, teste: "Perfil de SNP/DNA (Teste de Paternidade)" },
        { padrao: /painel\s+saúde.*painel\s+origem|painel\s+origem.*painel\s+saúde|ultra.*raças.*doenças|raças.*doenças/i, teste: "Painel Saúde + Painel Origem" },
        { padrao: /saúde.*doenças\s+genéticas|doenças\s+genéticas|avançado.*doenças/i, teste: "Saúde - Identificação de Doenças Genéticas" },
        { padrao: /origem.*raças|identificação\s+de\s+raças/i, teste: "Origem - Identificação de Raças" }
      ];

      // Função auxiliar para verificar padrões
      function verificarPadroes(texto) {
        if (!texto) return null;
        const textoLower = texto.toLowerCase();

        // Verifica correspondência exata primeiro
        for (const testeValido of testesValidos) {
          if (textoLower === testeValido.toLowerCase()) {
            return testeValido;
          }
        }

        // Verifica padrões usando regex (ordem importa - mais específicos primeiro)
        for (const { padrao, teste } of mapeamentoTestes) {
          if (padrao.test(texto)) {
            return teste;
          }
        }

        return null;
      }

      // Verifica tags do pedido primeiro
      if (order.tags) {
        const tagsArray = order.tags.split(",").map(tag => tag.trim());
        for (const tag of tagsArray) {
          const testeEncontrado = verificarPadroes(tag);
          if (testeEncontrado) {
            return testeEncontrado;
          }
        }
      }

      // Verifica nos nomes dos produtos (line_items)
      if (order.line_items && Array.isArray(order.line_items)) {
        // Verifica cada produto individualmente
        for (const item of order.line_items) {
          const nomeProduto = (item.name || item.title || "").trim();
          if (nomeProduto) {
            const testeEncontrado = verificarPadroes(nomeProduto);
            if (testeEncontrado) {
              return testeEncontrado;
            }
          }
        }

        // Se não encontrou em produtos individuais, verifica todos juntos
        const todosProdutos = order.line_items
          .map(item => (item.name || item.title || "").trim())
          .filter(Boolean)
          .join(" ");

        if (todosProdutos) {
          const testeEncontrado = verificarPadroes(todosProdutos);
          if (testeEncontrado) {
            return testeEncontrado;
          }
        }
      }

      // Se não encontrou teste válido, retorna null
      return null;
    }

    // Monta os campos base com os nomes exatos da tabela Shopify_Vendas
    // Nota: "A" e "#" são apenas indicadores de tipo no Airtable, não fazem parte do nome do campo
    // Campos confirmados que funcionam: Name, Sobrenome, Telefone, UF, Teste, Pedido
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

    // Adiciona campo Teste apenas se houver um teste válido no pedido
    const testeValido = obterTesteValido(order);
    if (testeValido) {
      camposBase["Teste"] = testeValido;
      console.log(`🧪 Teste válido encontrado: "${testeValido}"`);
    } else {
      console.log("ℹ️ Nenhum teste válido encontrado no pedido. Campo Teste não será enviado.");
    }

    // Adiciona campo "Pedido" (campo numérico no Airtable, indicado por "#" no Airtable)
    if (order.order_number) {
      camposBase["Pedido"] = Number(order.order_number) || parseInt(order.order_number, 10);
    }

    // Adiciona o campo de data
    if (dataFormatada) {
      camposBase["Data da Compra"] = dataFormatada;
    }

    // Adiciona "Status de Pagamento" (as opções válidas são "Pago", "Pagamento Pendente", ou "Pagamento Expirado")
    camposBase["Status de Pagamento"] = traduzirStatusPagamento(order.financial_status);

    // Remove campos vazios antes de enviar (importante para campos select)
    const camposLimpos = removerCamposVazios(camposBase);

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

    // Tenta salvar
    let resultado;
    try {
      resultado = await tentarSalvarNoAirtable(camposLimpos);
      const data = resultado.data;

      console.log("✅ Cliente salvo no Airtable com ID:", data.records[0].id);
      console.log("📋 Campos salvos:", resultado.camposEnviados.join(", "));

      // Lista campos que foram removidos (comparando com campos originais)
      const camposRemovidos = Object.keys(camposLimpos).filter(campo => !resultado.camposEnviados.includes(campo));
      if (camposRemovidos.length > 0) {
        console.warn("⚠️ Campos removidos porque não existem na tabela:", camposRemovidos.join(", "));
        console.warn("📋 Campos que funcionam atualmente:", resultado.camposEnviados.join(", "));
        console.warn("");
        console.warn("💡 Para incluir os campos removidos, você precisa criá-los na tabela 'Shopify_Vendas' do Airtable:");
        console.warn("   1. Abra a tabela 'Shopify_Vendas' no Airtable");
        console.warn("   2. Clique no '+' no final das colunas para adicionar novos campos");
        console.warn("   3. Crie os campos com os nomes EXATOS (case-sensitive):");
        camposRemovidos.forEach(campo => {
          console.warn(`      - "${campo}" (tipo: Text ou o tipo apropriado)`);
        });
        console.warn("   4. Após criar os campos, os próximos pedidos serão salvos com esses dados");
      }

      res.status(200).send("OK");
    } catch (err) {
      // Se foi erro do Airtable
      if (err.data) {
        console.error("❌ Erro ao salvar no Airtable após múltiplas tentativas:", JSON.stringify(err.data, null, 2));
        console.error("📋 Campos que foram tentados:", err.camposEnviados);
        return res.status(500).send("Erro ao salvar no Airtable");
      }
      // Se foi outro tipo de erro
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