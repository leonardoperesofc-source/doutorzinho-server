import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const redis = Redis.fromEnv();

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_SECURITY = process.env.ZAPI_SECURITY_TOKEN;

// Máximo de mensagens no histórico por usuário
const MAX_HISTORICO = 10;
// Tempo de expiração do histórico: 2 horas de inatividade
const HISTORICO_TTL = 60 * 60 * 2;

const PROMPT_DOUTORZINHO = `Você é o Doutorzinho, um assistente simpático, acolhedor e inteligente que explica resultados de exames médicos e tira dúvidas gerais SOMENTE sobre saúde para brasileiros comuns.

Seu estilo:
- Fala como um médico amigo de família — próximo, claro, sem jargão
- Nunca alarma desnecessariamente
- Sempre contextualiza: "isso é comum", "não é urgência", "vale checar com seu médico"
- Usa emojis com moderação para deixar o tom mais leve
- Máximo 5 parágrafos curtos — vai direto ao ponto
- Seja relacional e continue a conversa naturalmente — lembre do que o usuário disse antes
- Faça perguntas de acompanhamento quando fizer sentido
- Se o usuário responder algo sobre sua análise anterior, continue de onde parou

Estrutura da sua resposta quando analisar exame:
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
- Termine sempre com: "Lembre-se: não esqueça de consultar seu médico. 🩺"
- NUNCA peça para o usuário enviar o exame novamente se ele já enviou antes nessa conversa
- Se o usuário fizer perguntas de acompanhamento, responda naturalmente sem reiniciar a conversa`;

async function enviarMensagem(telefone, mensagem) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_SECURITY,
    },
    body: JSON.stringify({ phone: telefone, message: mensagem, delayMessage: 3 }),
  });
}

async function simularDigitando(telefone) {
  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-chat-state`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": ZAPI_SECURITY,
      },
      body: JSON.stringify({ phone: telefone, chatState: "COMPOSING" }),
    });
    await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (err) {
    console.log("Erro no simularDigitando:", err);
  }
}

async function urlParaBase64(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Falha ao baixar imagem: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString("base64");
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const mimetype = contentType.split(";")[0].trim();
  return { base64, mimetype };
}

// Carrega histórico do Redis
async function carregarHistorico(telefone) {
  try {
    const raw = await redis.get(`historico:${telefone}`);
    if (!raw) return [];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
}

// Salva histórico no Redis com TTL
async function salvarHistorico(telefone, historico) {
  try {
    // Mantém só as últimas MAX_HISTORICO mensagens
    const recente = historico.slice(-MAX_HISTORICO);
    await redis.set(`historico:${telefone}`, JSON.stringify(recente), { ex: HISTORICO_TTL });
  } catch (err) {
    console.log("Erro ao salvar histórico:", err);
  }
}

// Resposta com histórico completo
async function responderComHistorico(telefone, novaMensagem, imagemData = null) {
  const historico = await carregarHistorico(telefone);

  // Monta a nova mensagem do usuário
  let novoConteudo;
  if (imagemData) {
    const mimetypeValido = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(imagemData.mimetype)
      ? imagemData.mimetype
      : "image/jpeg";
    novoConteudo = [
      {
        type: "image",
        source: { type: "base64", media_type: mimetypeValido, data: imagemData.base64 },
      },
      {
        type: "text",
        text: novaMensagem || "Analise este exame.",
      },
    ];
  } else {
    novoConteudo = novaMensagem;
  }

  // Adiciona ao histórico
  historico.push({ role: "user", content: novoConteudo });

  // Chama o Claude com todo o histórico
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: PROMPT_DOUTORZINHO,
    messages: historico,
  });

  const respostaTexto = response.content[0].text;

  // Salva resposta do assistente no histórico
  historico.push({ role: "assistant", content: respostaTexto });
  await salvarHistorico(telefone, historico);

  return respostaTexto;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // Formata telefone e corrige 9º dígito se necessário
    let telefone = body?.phone?.replace(/\D/g, "");
    if (telefone && telefone.startsWith("55") && telefone.length === 12) {
      telefone = telefone.slice(0, 4) + "9" + telefone.slice(4);
    }

    const tipo = body?.type;

    console.log("Telefone formatado:", telefone);
    console.log("Chave Redis buscada:", `assinante:${telefone}`);

    if (!telefone) return res.status(200).json({ ok: true });

    // Ignora mensagens enviadas pelo próprio bot
    if (body?.fromMe) return res.status(200).json({ ok: true });

    // Anti-duplicata via Redis
    const messageId = body?.messageId || body?.id || null;
    if (messageId) {
      const salvou = await redis.set(`msg:${messageId}`, "1", { nx: true, ex: 300 });
      if (!salvou) {
        console.log("Mensagem duplicada ignorada:", messageId);
        return res.status(200).json({ ok: true });
      }
    }

    // Verifica se é assinante
    const isAssinante = await redis.get(`assinante:${telefone}`);
    if (!isAssinante) {
      await enviarMensagem(
        telefone,
        `Olá! 👋 Sou o *Doutorzinho*, seu assistente de saúde.\n\nPara receber análises dos seus exames, você precisa ser assinante do *SeuExamify*.\n\n👉 Acesse: https://seuexamify.com.br e escolha seu plano.\n\nQualquer dúvida, estamos aqui! 😊`
      );
      return res.status(200).json({ ok: true });
    }

    const textoRecebido = body?.text?.message || body?.message || "";
    const imagemUrl = body?.image?.imageUrl || body?.image?.imageMessage?.url || null;
    const imagemBase64Direto = body?.image?.imageMessage?.base64 || body?.image?.base64 || null;
    const imagemMimeDireto = body?.image?.imageMessage?.mimetype || body?.image?.mimetype || "image/jpeg";
    const isDocumento = tipo === "document" || body?.document;

    console.log("TIPO:", tipo, "TEM URL:", !!imagemUrl, "TEM BASE64:", !!imagemBase64Direto);

    // Saudação simples — não usa histórico
    const txt = textoRecebido.toLowerCase().trim();
    const ehSaudacao = (txt === "oi" || txt === "olá" || txt === "ola" || txt === "hello" || txt === "hi" || txt.length <= 2) && !imagemUrl && !imagemBase64Direto;

    if (ehSaudacao) {
      await enviarMensagem(
        telefone,
        `Olá! 👋 Sou o *Doutorzinho*, seu assistente de saúde do SeuExamify!\n\nPosso te ajudar de duas formas:\n\n📸 *Envie uma foto* do seu exame e eu analiso na hora\n❓ *Digite sua dúvida* sobre algum valor específico\n\nComo posso te ajudar hoje? 😊`
      );
      return res.status(200).json({ ok: true });
    }

    let resposta = "";

    if (imagemUrl) {
      try {
        await enviarMensagem(telefone, "⏳ Recebi seu exame! O Doutorzinho está analisando... aguarda uns 30 segundos 🩺");
        const { base64, mimetype } = await urlParaBase64(imagemUrl);
        resposta = await responderComHistorico(telefone, textoRecebido || "Analise este exame médico.", { base64, mimetype });
      } catch (err) {
        console.error("Erro ao baixar imagem:", err);
        resposta = "😕 Tive um problema ao acessar sua imagem. Tenta mandar a foto novamente!";
      }
    } else if (imagemBase64Direto) {
      await enviarMensagem(telefone, "⏳ Recebi seu exame! O Doutorzinho está analisando... aguarda uns 30 segundos 🩺");
      resposta = await responderComHistorico(telefone, textoRecebido || "Analise este exame médico.", { base64: imagemBase64Direto, mimetype: imagemMimeDireto });
    } else if (isDocumento) {
      resposta = `📄 Recebi seu PDF!\n\nPor enquanto analiso melhor por *foto do exame*. Tira uma foto nítida do resultado e manda aqui que eu analiso na hora! 📸`;
    } else if (textoRecebido) {
      resposta = await responderComHistorico(telefone, textoRecebido);
    }

    if (resposta) {
      await enviarMensagem(telefone, resposta);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(200).json({ ok: true });
  }
}
