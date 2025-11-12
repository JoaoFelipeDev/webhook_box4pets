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
    
    // Busca o nome da clínica/hospital em múltiplos lugares
    const nomeClinicaHospital = 
      shippingAddress.company || 
      billingAddress.company || 
      customer.note || 
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

    // Função para formatar informações adicionais do pedido
    function formatarInformacoesAdicionais(order) {
      const info = [];
      
      if (order.order_number) {
        info.push(`Pedido #${order.order_number}`);
      }
      
      if (order.total_price) {
        info.push(`Total: R$ ${parseFloat(order.total_price).toFixed(2)}`);
      }
      
      if (order.payment_gateway_names && order.payment_gateway_names.length > 0) {
        info.push(`Pagamento: ${order.payment_gateway_names.join(", ")}`);
      }
      
      if (order.shipping_lines && order.shipping_lines.length > 0) {
        const shippingMethod = order.shipping_lines[0].title || "Não especificado";
        info.push(`Envio: ${shippingMethod}`);
      }
      
      if (order.line_items && order.line_items.length > 0) {
        const totalItems = order.line_items.reduce((sum, item) => sum + (item.quantity || 0), 0);
        info.push(`Itens: ${totalItems} produto(s)`);
      }
      
      if (order.note) {
        info.push(`Nota: ${order.note}`);
      }
      
      if (order.tags && order.tags.trim()) {
        info.push(`Tags: ${order.tags}`);
      }
      
      if (order.order_status_url) {
        info.push(`URL: ${order.order_status_url}`);
      }
      
      return info.join(" | ") || "Sem informações adicionais";
    }

    const airtableRecord = {
      records: [
        {
          fields: {
            Nome: customer.first_name || "",
            Sobrenome: customer.last_name || "",
            Email: customer.email || "",
            Telefone: firstAddress.phone || customer.phone || "",
            Endereço: firstAddress.address1 || "",
            CEP: firstAddress.zip || "",
            Cidade: firstAddress.city || "",
            Estado: firstAddress.province || "",
            CRMV: "", // opcional, você pode deixar fixo ou buscar em outro lugar
            "Nome da Clínica ou Hospital": nomeClinicaHospital,
            "Data do Pedido": order.created_at || "",
            "Status do Pagamento": traduzirStatusPagamento(order.financial_status),
            "Informações Adicionais": formatarInformacoesAdicionais(order),
            // TAG: "Shopify"
          }
        }
      ]
    };

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