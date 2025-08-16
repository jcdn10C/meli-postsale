import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  SITE_ID = "MLB",
  MELI_APP_ID,
  MELI_CLIENT_SECRET,
  MELI_REDIRECT_URI,
  MELI_ACCESS_TOKEN,
  MELI_REFRESH_TOKEN,
  MELI_SELLER_ID
} = process.env;

const pdfMap = JSON.parse(fs.readFileSync(path.join(__dirname, "config/pdf-map.json"), "utf8"));

// --- helpers HTTP ---
async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body && (headers["Content-Type"]?.includes("json") ? JSON.stringify(body) : body)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function exchangeCodeForToken(code) {
  const p = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: MELI_APP_ID,
    client_secret: MELI_CLIENT_SECRET,
    code,
    redirect_uri: MELI_REDIRECT_URI
  });
  return http("POST", "https://api.mercadolibre.com/oauth/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p
  });
}

async function refreshToken(refresh_token) {
  const p = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: MELI_APP_ID,
    client_secret: MELI_CLIENT_SECRET,
    refresh_token
  });
  return http("POST", "https://api.mercadolibre.com/oauth/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p
  });
}

async function uploadAttachment(accessToken, pdfFullPath, filename) {
  const form = new FormData();
  form.append("file", fs.createReadStream(pdfFullPath), { filename });
  const url = `https://api.mercadolibre.com/messages/attachments?tag=post_sale&site_id=${SITE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form
  });
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();
  return j.id; // file_id
}

async function sendPostSaleMessage(accessToken, { packId, toUserId, sellerId, fileId, text }) {
  const url = `https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`;
  const body = {
    from: { user_id: String(sellerId) },
    to:   { user_id: String(toUserId) },
    text: { plain: text },
    attachments: fileId ? [{ id: fileId }] : []
  };
  return http("POST", url, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body
  });
}

// --- rotas ---
app.get("/", (_req, res) => res.send("OK - Impulso Alpha | Post-sale ML"));

app.get("/meli/auth", (_req, res) => {
  const url = new URL("https://auth.mercadolibre.com/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", MELI_APP_ID);
  url.searchParams.set("redirect_uri", MELI_REDIRECT_URI);
  return res.redirect(url.toString());
});

app.get("/meli/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("code ausente");
    const tok = await exchangeCodeForToken(code);
    console.log("TOKENS:", tok); // Guarde com segurança (DB)
    return res.send("Conectado ao Mercado Livre! Você pode fechar esta janela.");
  } catch (e) {
    console.error("OAuth error:", e.message);
    return res.status(500).send("Erro na autorização.");
  }
});

app.post("/meli/webhook", async (req, res) => {
  res.sendStatus(200); // responda rápido
  try {
    const { topic, resource } = req.body || {};
    if (topic === "orders_v2" && resource?.includes("/orders/")) {
      const orderId = resource.split("/").pop();

      // 1) Consultar ordem
      const order = await http("GET", `https://api.mercadolibre.com/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${MELI_ACCESS_TOKEN}` }
      });
      if (order.status !== "paid") return;

      const packId  = order.pack_id || orderId;
      const buyerId = order.buyer?.id;
      const items   = order.order_items || [];

      // 2) Para cada item, localizar PDF e enviar
      for (const it of items) {
        const itemId = it.item?.id;
        const pdfName = itemId && pdfMap[itemId];
        if (!pdfName) continue;

        const pdfFullPath = path.join(__dirname, "pdfs", pdfName);
        const fileId = await uploadAttachment(MELI_ACCESS_TOKEN, pdfFullPath, `${itemId}.pdf`);

        const text = "Olá! Obrigado pela compra. Segue seu arquivo em anexo. Qualquer dúvida, estamos à disposição.";
        await sendPostSaleMessage(MELI_ACCESS_TOKEN, {
          packId,
          toUserId: buyerId,
          sellerId: MELI_SELLER_ID,
          fileId,
          text
        });
      }
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server ON:", process.env.PORT || 3000));
