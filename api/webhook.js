import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_SECURITY = process.env.ZAPI_SECURITY_TOKEN;

// Números assinantes autorizados (substitua pelo seu sistema de pagamento)
const ASSINANTES = new Set([
  "5516982617105",
]);

const PROMPT_DOUTORZINHO = `Você é o Doutorzinho, um assistente simpático, acolhedor e inteligente que explica resultados de exames médicos para brasileiros comuns.

Seu estilo:
- Fala como um médico amigo de família — próximo, claro, sem jargão
- Nunca alarma desnecessariamente
- Sempre contextualiza: "isso é comum", "não é urgência", "vale checar com seu médico"
- Usa emojis com moderação para deixar o tom mais leve
- Máximo 5 parágrafos curtos — vai direto ao ponto

Estrutura da sua resposta:
1. Resumo rápido do que encontrou (1-2 linhas)
2. O que está normal ✅
3. O que merece atenção ⚠️ (se houver)
4. O que fazer agora (próximos passos práticos)
5. 2-3 perguntas para levar ao médico

Regras absolutas:
- NUNCA faça diagnóstico
- NUNCA diga que algo é certamente uma doença
- SEMPRE sugira consultar o médico para confirmação
- Se a imagem não for um exame médico, diga gentilmente que só analisa exames
- Termine sempre com: "Lembre-se: sou uma IA educacional e não substituo seu médico 🩺"`;

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

async function analisarComImagem(base64, mimetype, telefone) {
  await enviarMensagem(
    telefone,
    "⏳ Recebi seu exame! O Doutorzinho está analisando... aguarda uns 30 segundos 🩺"
  );

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimetype, data: base64 },
          },
          {
            type: "text",
            text: PROMPT_DOUTORZINHO + "\n\nAnalise o exame nesta imagem.",
          },
        ],
      },
    ],
  });

  return response.content[0].text;
}

async function analisarComTexto(pergunta) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: PROMPT_DOUTORZINHO + "\n\nPergunta do paciente: " + pergunta,
      },
    ],
  });

  return response.content[0].text;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;
    const telefone = body?.phone?.replace(/\D/g, "");
    const tipo = body?.type;

    if (!telefone) return res.status(200).json({ ok: true });

    // Ignora mensagens enviadas pelo próprio bot
    if (body?.fromMe) return res.status(200).json({ ok: true });

    // Verifica se é assinante
    if (!ASSINANTES.has(telefone)) {
      await enviarMensagem(
        telefone,
        `Olá! 👋 Sou o *Doutorzinho*, seu assistente de saúde.\n\nPara receber análises dos seus exames, você precisa ser assinante do *SeuExamify*.\n\n👉 Acesse: https://seuexamify.com.br e escolha seu plano.\n\nQualquer dúvida, estamos aqui! 😊`
      );
      return res.status(200).json({ ok: true });
    }

    let resposta = "";

    // Extrai texto — Z-API envia em body.text.message
    const textoRecebido = body?.text?.message || body?.message || "";

    // Extrai imagem
    const imagemBase64 = body?.image?.imageMessage?.base64 || body?.image?.base64 || null;
    const imagemMime = body?.image?.imageMessage?.mimetype || body?.image?.mimetype || "image/jpeg";

    // Verifica se é documento/PDF
    const isDocumento = tipo === "document" || body?.document;

    console.log("TIPO:", tipo, "TEXTO:", textoRecebido, "TEM IMAGEM:", !!imagemBase64);

    // Mensagem com imagem (foto do exame)
    if (imagemBase64) {
      resposta = await analisarComImagem(imagemBase64, imagemMime, telefone);
    }

    // PDF (documento)
    else if (isDocumento) {
      resposta = `📄 Recebi seu PDF!\n\nPor enquanto analiso melhor por *foto do exame*. Tira uma foto nítida do resultado e manda aqui que eu analiso na hora! 📸`;
    }

    // Mensagem de texto
    else if (textoRecebido) {
      const txt = textoRecebido.toLowerCase();
      if (txt.includes("oi") || txt.includes("olá") || txt.includes("ola") || txt.includes("hello") || txt.length <= 3) {
        resposta = `Olá! 👋 Sou o *Doutorzinho*, seu assistente de saúde do SeuExamify!\n\nPosso te ajudar de duas formas:\n\n📸 *Envie uma foto* do seu exame e eu analiso na hora\n❓ *Digite sua dúvida* sobre algum valor específico\n\nComo posso te ajudar hoje? 😊`;
      } else {
        resposta = await analisarComTexto(textoRecebido);
      }
    }

    if (resposta) {
      await enviarMensagem(telefone, resposta);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(200).json({ ok: true }); // Sempre retorna 200 para o Z-API
  }
}
