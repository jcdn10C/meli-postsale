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
  SITE_ID = "MLB",
  MELI_APP_ID,
  MELI_CLIENT_SECRET,
  MELI_REDIRECT_URI,
  MELI_SELLER_ID,
  MELI_ACCESS_TOKEN,
  MELI_REFRESH_TOKEN,
} = process.env;

let pdfMap = {};
try {
  const mapPath = path.join(__dirname, "config/pdf-map.json");
  if (fs.existsSync(mapPath)) {
    pdfMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  }
} catch (e) {
  console.error("Erro ao carregar pdf-map.json:", e.message);
}

const TOKEN_FILE = path.join("/tmp", "meli_tokens.json");
let tokenState = null;

try {
  if (fs.existsSync(TOKEN_FILE)) {
    tokenState = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } else if (MELI_ACCESS_TOKEN || MELI_REFRESH_TOKEN) {
    tokenState = {
      access_token: MELI_ACCESS_TOKEN || null,
      refresh_token: MELI_REFRESH_TOKEN || null,
      expires_at: 0,
    };
  }
} catch (e) {
  console.error("Erro ao carregar tokens:", e.message);
}

function saveTokens(tokens) {
  tokenState = tokens;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.error("Erro ao salvar tokens:", e.message);
  }
}

async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body && (headers["Content-Type"]?.includes("json") ? JSON.stringify(body) : body),
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
    redirect_uri: MELI_REDIRECT_URI,
  });

  const data = await http("POST", "https://api.mercadolibre.com/oauth/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p,
  });

  const now = Math.floor(Date.now() / 1000);
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user_id,
    expires_at: now + (data.expires_in || 0) - 60,
  });
  return data;
}

async function refreshToken(refresh_token) {
  const p = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: MELI_APP_ID,
    client_secret: MELI_CLIENT_SECRET,
    refresh_token,
  });

  const data = await http("POST", "https://api.mercadolibre.com/oauth/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p,
  });

  const now = Math.floor(Date.now() / 1000);
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    user_id: data.user_id,
    expires_at: now + (data.expires_in || 0) - 60,
  });
  return data;
}

async function getAccessToken() {
  if (!tokenState || !tokenState.access_token) {
    throw new Error("Sem tokens. Autorize o app em /meli/auth.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (!tokenState.expires_at || tokenState.expires_at <= now) {
    if (!tokenState.refresh_token) throw new Error("Token expirado. Reautorize.");
    await refreshToken(tokenState.refresh_token);
  }
  return tokenState.access_token;
}

async function uploadAttachment(accessToken, pdfFullPath, filename) {
  if (!fs.existsSync(pdfFullPath)) throw new Error(`Arquivo não encontrado: ${pdfFullPath}`);
  const form = new FormData();
  form.append("file", fs.createReadStream(pdfFullPath), { filename });
  const url = `https://api.mercadolibre.com/messages/attachments?tag=post_sale&site_id=${SITE_ID}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).id;
}

async function sendPostSaleMessage(accessToken, { packId, toUserId, sellerId, fileId, text }) {
  const url = `https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`;
  const body = {
    from: { user_id: String(sellerId) },
    to: { user_id: String(toUserId) },
    text: { plain: text },
    attachments: fileId ? [{ id: fileId }] : [],
  };
  return http("POST", url, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body,
  });
}

app.get("/", (_req, res) => res.send("OK - Impulso Alpha | Post-sale ML"));

app.get("/meli/auth", (_req, res) => {
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", MELI_APP_ID);
  url.searchParams.set("redirect_uri", MELI_REDIRECT_URI);
  url.searchParams.set("state", "mlb-postsale");
  res.redirect(url.toString());
});

app.get("/meli/me", async (_req, res) => {
  try {
    const at = await getAccessToken();
    const me = await http("GET", "https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${at}` },
    });
    res.json({ id: me.id, nickname: me.nickname });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post("/meli/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const { topic, resource } = req.body || {};
    if (topic === "orders_v2" && resource?.includes("/orders/")) {
      const orderId = resource.split("/").pop();
      const accessToken = await getAccessToken();
      const order = await http("GET", `https://api.mercadolibre.com/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (order.status !== "paid") return;

      const packId = order.pack_id || orderId;
      const buyerId = order.buyer?.id;
      for (const it of order.order_items || []) {
        const pdfName = it.item?.id && pdfMap[it.item.id];
        if (!pdfName) continue;
        const pdfFullPath = path.join(__dirname, "pdfs", pdfName);
        const fileId = await uploadAttachment(accessToken, pdfFullPath, `${it.item.id}.pdf`);
        const text = "Olá! Obrigado pela compra. Segue seu arquivo em anexo.";
        await sendPostSaleMessage(accessToken, {
          packId,
          toUserId: buyerId,
          sellerId: MELI_SELLER_ID,
          fileId,
          text,
        });
      }
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server ON:", PORT));
