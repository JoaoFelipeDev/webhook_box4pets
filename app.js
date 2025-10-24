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

    const customer = order.customer || {};

    console.log("📦 Processando cliente:", customer);

    // Dados do cliente vindos do pedido Shopify
    const firstAddress = order.shipping_address || order.billing_address || {};

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
            "Nome da Clínica ou Hospital": firstAddress.company || "",
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