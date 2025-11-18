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
    function traduzirStatusPagamento(financialStatus) {
      const statusMap = {
        "pending": "Pendente",
        "paid": "Pago",
        "authorized": "Autorizado",
        "partially_paid": "Parcialmente Pago",
        "refunded": "Reembolsado",
        "voided": "Cancelado",
        "partially_refunded": "Parcialmente Reembolsado"
      };
      return statusMap[financialStatus] || financialStatus || "Desconhecido";
    }

    // Função para formatar data para o Airtable (formato ISO 8601)
    function formatarDataParaAirtable(dateString) {
      if (!dateString) return "";
      // O Airtable aceita formato ISO 8601: YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss.sssZ
      // O Shopify já envia no formato correto, mas vamos garantir
      try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return "";
        // Retorna no formato ISO 8601 completo
        return date.toISOString();
      } catch (e) {
        console.warn("⚠️ Erro ao formatar data:", dateString, e);
        return dateString; // Retorna o original se não conseguir formatar
      }
    }

    // Formata a data para o Airtable
    const dataFormatada = formatarDataParaAirtable(order.created_at);
    
    // Monta os campos base (sem campos que podem ter nomes diferentes)
    const camposBase = {
      Nome: customer.first_name || "",
      Sobrenome: customer.last_name || "",
      Teste: "", // campo disponível para uso futuro
      Email: customer.email || order.email || "",
      Telefone: telefone,
      Endereço: enderecoCompleto,
      CEP: firstAddress.zip || "",
      Cidade: firstAddress.city || "",
      Estado: firstAddress.province || "",
      CRMV: "", // opcional, você pode deixar fixo ou buscar em outro lugar
      "Nome da Clínica ou Hospital": nomeClinicaHospital,
      TAG: "Shopify",
      "Status de Pagamento": traduzirStatusPagamento(order.financial_status)
    };
    
    // Adiciona campos opcionais que podem ter nomes diferentes
    // Tenta diferentes variações do nome do campo "Pedido"
    // Se o campo "Pedido" não existir, o código tentará sem ele automaticamente
    if (order.order_number) {
      // Tenta primeiro com "Pedido" (nome mais comum)
      // Se não funcionar, o tratamento de erro tentará sem este campo
      camposBase["Pedido"] = String(order.order_number);
    }
    
    // Adiciona o campo de data
    if (dataFormatada) {
      camposBase["Data da Compra"] = dataFormatada;
    }
    
    const airtableRecord = {
      records: [
        {
          fields: camposBase
        }
      ]
    };
    
    // Log do payload que será enviado ao Airtable
    console.log("📤 Payload para Airtable:", JSON.stringify(airtableRecord, null, 2));
    console.log("📅 Data original:", order.created_at);
    console.log("📅 Data formatada:", dataFormatada);

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Shopify`, {
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
      
      // Se o erro for de campo desconhecido, tenta remover campos problemáticos
      if (data.error && data.error.type === 'UNKNOWN_FIELD_NAME') {
        const campoErro = data.error.message.match(/"([^"]+)"/)?.[1];
        console.warn(`⚠️ Campo desconhecido: "${campoErro}". Tentando remover campos problemáticos...`);
        
        // Lista de campos que podem causar problemas (tenta remover um por vez)
        const camposProblema = ["Pedido", "Data da Compra", "A # Pedido", "# Pedido"];
        let camposLimpos = { ...airtableRecord.records[0].fields };
        
        // Remove o campo que causou o erro
        if (campoErro) {
          delete camposLimpos[campoErro];
          // Também tenta variações comuns
          camposProblema.forEach(campo => {
            if (camposLimpos[campo]) {
              delete camposLimpos[campo];
            }
          });
        } else {
          // Se não conseguir identificar, remove campos suspeitos
          camposProblema.forEach(campo => {
            if (camposLimpos[campo]) {
              delete camposLimpos[campo];
            }
          });
        }
        
        console.log("🔄 Tentando com campos:", Object.keys(camposLimpos));
        
        const retryRecord = {
          records: [{ fields: camposLimpos }]
        };
        
        const retryResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Shopify`, {
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
          if (retryData.error && retryData.error.type === 'UNKNOWN_FIELD_NAME') {
            const novoCampoErro = retryData.error.message.match(/"([^"]+)"/)?.[1];
            console.error(`❌ Outro campo problemático encontrado: "${novoCampoErro}"`);
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