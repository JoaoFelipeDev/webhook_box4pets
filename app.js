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
        "pending": "Pendente",
        "paid": "Pago",
        "authorized": "Pago", // Autorizado = já foi aprovado, considera como pago
        "partially_paid": "Pago", // Parcialmente pago = tem pagamento, considera como pago
        "refunded": "Pendente", // Reembolsado = não está mais pago
        "voided": "Pendente", // Cancelado = não está pago
        "partially_refunded": "Pendente" // Parcialmente reembolsado = não está totalmente pago
      };
      // Retorna apenas "Pago" ou "Pendente" (opções válidas no Airtable)
      return statusMap[financialStatus] || "Pendente";
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
    
    // Monta os campos base (sem campos que podem ter nomes diferentes)
    const camposBase = {
      Nome: customer.first_name || "",
      Sobrenome: customer.last_name || "",
      Email: customer.email || order.email || "",
      Telefone: telefone,
      Endereço: enderecoCompleto,
      CEP: firstAddress.zip || "",
      Cidade: firstAddress.city || "",
      Estado: firstAddress.province || "",
      "Nome da Clínica ou Hospital": nomeClinicaHospital
      // "Status de Pagamento" removido temporariamente pois está causando erros de select inválido
      // Se o campo existir no Airtable com opções válidas, descomente a linha abaixo:
      // "Status de Pagamento": traduzirStatusPagamento(order.financial_status)
    };
    
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
    
    // Adiciona campos opcionais apenas se tiverem valor (para evitar problemas com campos select)
    if (order.order_number) {
      camposBase["Pedido"] = String(order.order_number);
    }
    
    // Adiciona CRMV apenas se tiver valor (comentado para evitar problemas com select)
    // CRMV: "", // opcional - não enviar vazio se for select
    
    // Adiciona o campo de data
    if (dataFormatada) {
      camposBase["Data da Compra"] = dataFormatada;
    }
    
    // Remove campos vazios antes de enviar (importante para campos select)
    const camposLimpos = removerCamposVazios(camposBase);

    const airtableRecord = {
      records: [
        {
          fields: camposLimpos
        }
      ]
    };
    
    // Log do payload que será enviado ao Airtable
    console.log("📤 Payload para Airtable:", JSON.stringify(airtableRecord, null, 2));
    console.log("📅 Data original:", order.created_at);
    console.log("📅 Data formatada:", dataFormatada);

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Shopify_Vendas`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(airtableRecord)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro ao salvar no Airtable:", JSON.stringify(data, null, 2));
      console.error("📋 Campos enviados:", Object.keys(airtableRecord.records[0].fields));
      
      // Se o erro for de campo desconhecido, select inválido ou valor inválido, tenta remover campos problemáticos
      if (data.error && (data.error.type === 'UNKNOWN_FIELD_NAME' || 
                         data.error.type === 'INVALID_MULTIPLE_CHOICE_OPTIONS' ||
                         data.error.type === 'INVALID_VALUE_FOR_COLUMN')) {
        const campoErro = data.error.message.match(/"([^"]+)"/)?.[1];
        let tipoErro = 'campo desconhecido';
        if (data.error.type === 'INVALID_MULTIPLE_CHOICE_OPTIONS') {
          tipoErro = 'select inválido';
        } else if (data.error.type === 'INVALID_VALUE_FOR_COLUMN') {
          tipoErro = 'valor inválido';
        }
        console.warn(`⚠️ ${tipoErro}: "${campoErro || 'campo'}". Tentando remover campos problemáticos...`);
        
        // Lista de campos que podem causar problemas (tenta remover um por vez)
        const camposProblema = ["Pedido", "Data da Compra", "A # Pedido", "# Pedido", "Teste", "CRMV"];
        let camposLimpos = { ...airtableRecord.records[0].fields };
        
        // Se for erro de valor inválido (ex: formato de data incorreto)
        if (data.error.type === 'INVALID_VALUE_FOR_COLUMN') {
          // Remove o campo que causou o erro
          if (campoErro && camposLimpos[campoErro]) {
            delete camposLimpos[campoErro];
            console.log(`🗑️ Removendo campo com valor inválido: "${campoErro}"`);
          }
          // Se for "Data da Compra", remove também
          if (campoErro === "Data da Compra" || data.error.message.includes("Data da Compra")) {
            delete camposLimpos["Data da Compra"];
            console.log(`🗑️ Removendo campo "Data da Compra" (formato de data inválido)`);
          }
        }
        
        // Se for erro de select, remove campos que podem ser select (mesmo com valores)
        if (data.error.type === 'INVALID_MULTIPLE_CHOICE_OPTIONS') {
          const camposSelect = ["Teste", "CRMV", "TAG", "Status de Pagamento", "Nome da Clínica ou Hospital"];
          // Extrai o valor que causou o erro (pode ter aspas escapadas como ""Cancelado"" ou ""Shopify"")
          // Tenta diferentes padrões de aspas escapadas
          const valorErroSelect = data.error.message.match(/""([^"]+)""/)?.[1] || 
                                  data.error.message.match(/option "([^"]+)"/)?.[1] ||
                                  data.error.message.match(/option "?([^"]+)"?/)?.[1];
          
          console.log(`🔍 Valor que causou erro no select: "${valorErroSelect}"`);
          console.log(`🔍 Mensagem completa do erro: "${data.error.message}"`);
          
          // Tenta identificar qual campo tem esse valor
          let campoEncontrado = null;
          if (valorErroSelect) {
            const valorLimpo = valorErroSelect.trim();
            for (const [chave, valor] of Object.entries(camposLimpos)) {
              if (camposSelect.includes(chave) && String(valor).trim() === valorLimpo) {
                campoEncontrado = chave;
                console.log(`✅ Campo identificado: "${chave}" com valor "${valor}"`);
                break;
              }
            }
          }
          
          // Se encontrou o campo específico, remove apenas ele
          if (campoEncontrado) {
            delete camposLimpos[campoEncontrado];
            console.log(`🗑️ Removendo campo select com valor inválido: "${campoEncontrado}" (valor: "${valorErroSelect}")`);
          } else {
            // Se não conseguir identificar, tenta remover campos específicos baseado no valor
            const valorLimpo = valorErroSelect ? valorErroSelect.trim() : "";
            
            // Se o valor for "Cancelado" ou "Pendente", remove "Status de Pagamento"
            if ((valorLimpo === "Cancelado" || valorLimpo === "Pendente" || valorLimpo === "Pago") && camposLimpos["Status de Pagamento"]) {
              delete camposLimpos["Status de Pagamento"];
              console.log(`🗑️ Removendo campo "Status de Pagamento" (valor inválido: "${valorLimpo}")`);
            }
            // Se o valor for "Shopify", remove "TAG"
            else if (valorLimpo === "Shopify" && camposLimpos["TAG"]) {
              delete camposLimpos["TAG"];
              console.log(`🗑️ Removendo campo TAG (valor inválido: "Shopify")`);
            }
            // Se não conseguir identificar pelo valor, remove campos select comuns
            else {
              // Remove "Status de Pagamento" primeiro (mais comum causar esse erro)
              if (camposLimpos["Status de Pagamento"]) {
                delete camposLimpos["Status de Pagamento"];
                console.log(`🗑️ Removendo campo "Status de Pagamento" (valor inválido provável)`);
              }
              // Remove TAG se existir
              if (camposLimpos["TAG"]) {
                delete camposLimpos["TAG"];
                console.log(`🗑️ Removendo campo TAG (valor inválido provável)`);
              }
              // Remove outros campos select suspeitos
              camposSelect.forEach(campo => {
                if (camposLimpos[campo] && campo !== "TAG" && campo !== "Status de Pagamento") {
                  delete camposLimpos[campo];
                  console.log(`🗑️ Removendo campo select suspeito: "${campo}"`);
                }
              });
            }
          }
        }
        
        // Remove o campo que causou o erro (para erros de campo desconhecido)
        if (campoErro && data.error.type === 'UNKNOWN_FIELD_NAME') {
          delete camposLimpos[campoErro];
          console.log(`🗑️ Removendo campo desconhecido: "${campoErro}"`);
          // Também tenta variações comuns
          camposProblema.forEach(campo => {
            if (camposLimpos[campo]) {
              delete camposLimpos[campo];
            }
          });
        } else if (!campoErro && data.error.type === 'UNKNOWN_FIELD_NAME') {
          // Se não conseguir identificar, remove campos suspeitos
          camposProblema.forEach(campo => {
            if (camposLimpos[campo]) {
              delete camposLimpos[campo];
            }
          });
        }
        
        // Remove TODOS os campos vazios antes de tentar novamente (para evitar problemas com select)
        const camposLimposFinal = {};
        for (const [chave, valor] of Object.entries(camposLimpos)) {
          if (valor !== "" && valor !== null && valor !== undefined) {
            camposLimposFinal[chave] = valor;
          }
        }
        camposLimpos = camposLimposFinal;
        
        console.log("🔄 Tentando com campos:", Object.keys(camposLimpos));
        
        const retryRecord = {
          records: [{ fields: camposLimpos }]
        };
        
        const retryResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Shopify_Vendas`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.AIRTABLE_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(retryRecord)
        });
        
        const retryData = await retryResponse.json();
        if (retryResponse.ok) {
          console.log(`✅ Registro salvo sem o(s) campo(s) problemático(s). Campo removido: "${campoErro || 'campos suspeitos'}"`);
          console.log("💡 Verifique os nomes exatos dos campos no Airtable e ajuste o código se necessário.");
          return res.status(200).send("OK (alguns campos removidos)");
        } else {
          console.error("❌ Erro mesmo após remover campos:", JSON.stringify(retryData, null, 2));
          if (retryData.error) {
            if (retryData.error.type === 'UNKNOWN_FIELD_NAME') {
              const novoCampoErro = retryData.error.message.match(/"([^"]+)"/)?.[1];
              console.error(`❌ Outro campo problemático encontrado: "${novoCampoErro}"`);
            } else if (retryData.error.type === 'INVALID_MULTIPLE_CHOICE_OPTIONS') {
              console.error("❌ Erro com campo select: algum campo select está recebendo valor inválido ou vazio.");
              console.error("💡 Verifique se os campos 'Teste', 'CRMV' ou outros campos select existem e aceitam valores vazios.");
            }
          }
        }
      }
      
      return res.status(500).send("Erro ao salvar no Airtable");
    }

    console.log("✅ Cliente salvo no Airtable com ID:", data.records[0].id);
    res.status(200).send("OK");
  } catch (err) {
    console.error("💥 Erro no webhook:", err);
    res.status(500).send("Erro interno");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));