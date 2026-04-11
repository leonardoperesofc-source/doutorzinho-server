import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_SECURITY = process.env.ZAPI_SECURITY_TOKEN;
const PAYT_CHAVE = process.env.PAYT_INTEGRATION_KEY;

async function enviarMensagem(telefone, mensagem) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_SECURITY,
    },
    body: JSON.stringify({ phone: telefone, message: mensagem }),
  });
}

function formatarTelefone(phone) {
  if (!phone) return null;
  // Remove tudo que não for número
  let num = phone.replace(/\D/g, "");
  // Adiciona 55 se não tiver
  if (!num.startsWith("55")) {
    num = "55" + num;
  }
  return num;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;

    console.log("PAYT POSTBACK:", JSON.stringify(body, null, 2));

    // Valida chave de integração
    if (PAYT_CHAVE && body?.integration_key !== PAYT_CHAVE) {
      console.log("Chave inválida — ignorando postback");
      return res.status(200).json({ ok: true });
    }

    // Ignora testes
    if (body?.test === true) {
      console.log("Postback de teste — ignorando");
      return res.status(200).json({ ok: true });
    }

    // Só processa compras pagas/aprovadas
    const status = body?.status?.toLowerCase();
    const statusAprovado = ["paid", "approved", "finalizada", "aprovada", "complete", "completed"];
    if (!statusAprovado.includes(status)) {
      console.log("Status não aprovado:", status);
      return res.status(200).json({ ok: true });
    }

    // Pega telefone do cliente
    const telefoneRaw = body?.customer?.phone || body?.customer?.telephone || body?.customer?.mobile || null;
    const telefone = formatarTelefone(telefoneRaw);

    if (!telefone) {
      console.log("Telefone não encontrado no postback");
      return res.status(200).json({ ok: true });
    }

    console.log("Liberando acesso para:", telefone);

    // Salva no Redis com validade de 1 ano (em segundos)
    await redis.set(`assinante:${telefone}`, "1", { ex: 365 * 24 * 60 * 60 });

    // Manda mensagem de boas-vindas no WhatsApp
    await enviarMensagem(
      telefone,
      `Ola! Seu acesso ao Doutorzinho esta ativo agora mesmo! 🎉

Pode mandar a foto ou PDF do seu exame aqui nessa conversa que eu analiso em 30 segundos — sem jargao, sem susto.

Voce tambem pode me contar um valor especifico, tipo: "meu colesterol esta em 180" — e eu explico o que isso significa.

Ah, e criei seu Passaporte de Saude — um painel onde voce acompanha a evolucao de todos os seus exames ao longo do tempo. Para acessar:

👉 app.seuexamify.com.br

Crie sua conta com o mesmo e-mail que usou na compra e cadastre seu numero do WhatsApp no perfil para tudo ficar vinculado.

Estou aqui sempre que precisar!`
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no payt-webhook:", error);
    return res.status(200).json({ ok: true });
  }
}
