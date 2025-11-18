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

    const airtableRecord = {
      records: [
        {
          fields: {
            Nome: customer.first_name || "",
            Sobrenome: customer.last_name || "",
            "Data da Compra": order.created_at || "",
            Pedido: order.order_number ? String(order.order_number) : "",
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
          }
        }
      ]
    };
    
    // Log do payload que será enviado ao Airtable
    console.log("📤 Payload para Airtable:", JSON.stringify(airtableRecord, null, 2));

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
      console.error("❌ Erro ao salvar no Airtable:", data);
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