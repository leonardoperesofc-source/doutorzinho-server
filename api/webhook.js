import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const redis = Redis.fromEnv();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_SECURITY = process.env.ZAPI_SECURITY_TOKEN;

const MAX_HISTORICO = 10;
const HISTORICO_TTL = 60 * 60 * 2;

const NORMALIZACAO_METRICAS = {
  "colesterol total": "colesterol_total",
  "colesterol ldl": "colesterol_ldl",
  "ldl": "colesterol_ldl",
  "colesterol hdl": "colesterol_hdl",
  "hdl": "colesterol_hdl",
  "triglicerídeos": "triglicerideos",
  "triglicerideos": "triglicerideos",
  "glicemia": "glicemia",
  "glicose": "glicemia",
  "glicemia em jejum": "glicemia",
  "hemoglobina glicada": "hemoglobina_glicada",
  "hba1c": "hemoglobina_glicada",
  "vitamina d": "vitamina_d",
  "vitamina b12": "vitamina_b12",
  "hemoglobina": "hemoglobina",
  "leucócitos": "leucocitos",
  "plaquetas": "plaquetas",
  "ferritina": "ferritina",
  "ferro": "ferro",
  "tsh": "tsh",
  "t4 livre": "t4_livre",
  "creatinina": "creatinina",
  "ureia": "ureia",
  "psa": "psa",
  "pcr": "proteina_c_reativa",
};

function normalizarNome(nome) {
  const lower = nome.toLowerCase().trim();
  for (const [key, value] of Object.entries(NORMALIZACAO_METRICAS)) {
    if (lower.includes(key)) return value;
  }
  return lower.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

const PROMPT_DOUTORZINHO = `Voce e o Doutorzinho, um assistente de saude simpatico e acolhedor que explica resultados de exames medicos para brasileiros comuns. Fala como um medico amigo de familia — proximo, direto, sem termos tecnicos desnecessarios.

Formatacao das respostas:
- Escreva em texto corrido, como uma conversa de WhatsApp
- Use *negrito* (com asterisco simples) apenas para destacar valores alterados, nomes de exames importantes ou alertas que merecem atencao — nao use para listas ou titulos
- Nao use hashtags, tracos no inicio de linha, listas numeradas ou qualquer outro sinal de formatacao
- Paragrafos curtos, separados por linha em branco
- Maximo 4 paragrafos
- Tom acolhedor, nunca alarmista

Estrutura da resposta:
1. Frase acolhedora resumindo o quadro geral (1 linha)
2. O que esta normal e o que merece atencao — destacando em *negrito* os valores ou termos importantes
3. Se houver algo alterado: contextualize com calma, sem assustar
4. Perguntas para levar ao medico — sempre inclua 2 perguntas objetivas que o usuario pode fazer na proxima consulta
5. Frase final acolhedora lembrando de consultar o medico

Exemplo de formatacao correta:
"Analisei seu exame e no geral esta bem!

Sua *hemoglobina* (13,8) e seus *leucocitos* (7.200) estao dentro do normal. O que merece atencao e a sua *ferritina*, que esta em *18* — o ideal e acima de 30. Isso pode explicar aquela sensacao de cansaco que voce mencionou, mas nao e urgente.

Na sua proxima consulta, vale perguntar ao medico: qual o melhor suplemento de ferro para o seu caso? E em quanto tempo voce refaz o exame para acompanhar a melhora?

Nao se preocupe, voce esta no caminho certo. Qualquer duvida estou aqui!"

Regras absolutas:
- NUNCA faca diagnostico
- SEMPRE inclua 2 perguntas para o medico ao final
- SEMPRE use *negrito* nos valores alterados e nos nomes dos exames importantes
- NUNCA use *, #, - como inicio de linha para listas
- Continue a conversa naturalmente — lembre do que o usuario disse antes
- Quando perceber melhora no historico, comemore de forma genuina`
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": ZAPI_SECURITY },
    body: JSON.stringify({ phone: telefone, message: mensagem, delayMessage: 3 }),
  });
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

async function garantirUsuario(telefone) {
  await supabase
    .from("usuarios")
    .upsert({ telefone }, { onConflict: "telefone", ignoreDuplicates: true });
}

async function buscarHistoricoSaude(telefone) {
  const { data } = await supabase
    .from("metricas_saude")
    .select("nome, nome_normalizado, valor, unidade, status, data_exame")
    .eq("usuario_telefone", telefone)
    .order("data_exame", { ascending: false })
    .limit(30);
  return data || [];
}

function gerarContextoHistorico(historico) {
  if (!historico || historico.length === 0) return "";
  const grupos = {};
  for (const m of historico) {
    if (!grupos[m.nome_normalizado]) grupos[m.nome_normalizado] = [];
    if (grupos[m.nome_normalizado].length < 2) grupos[m.nome_normalizado].push(m);
  }
  const linhas = Object.entries(grupos).map(([_, valores]) => {
    const atual = valores[0];
    const anterior = valores[1];
    let linha = `- ${atual.nome}: ${atual.valor} ${atual.unidade || ""} (${atual.status})`;
    if (anterior) {
      const diff = atual.valor - anterior.valor;
      linha += ` | Anterior: ${anterior.valor} (${diff > 0 ? "+" : ""}${diff.toFixed(1)})`;
    }
    return linha;
  });
  return `\n\n[HISTÓRICO DO PACIENTE — use para comparações e celebrar melhorias]:\n${linhas.join("\n")}`;
}

async function extrairMetricasDeTexto(texto) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: PROMPT_EXTRACAO,
      messages: [{ role: "user", content: texto }],
    });
    const raw = response.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { metricas: [], tem_metricas: false };
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { metricas: [], tem_metricas: false };
  }
}

async function salvarMetricas(telefone, metricas, fonte, mensagemOriginal, dataExame) {
  if (!metricas || metricas.length === 0) return;
  await garantirUsuario(telefone);
  const registros = metricas.map(m => ({
    usuario_telefone: telefone,
    nome: m.nome,
    nome_normalizado: normalizarNome(m.nome),
    valor: parseFloat(m.valor),
    unidade: m.unidade || null,
    referencia: m.referencia || null,
    status: m.status || "normal",
    fonte,
    mensagem_original: mensagemOriginal?.substring(0, 500) || null,
    data_exame: dataExame || new Date().toISOString().split("T")[0],
  }));
  const { error } = await supabase.from("metricas_saude").insert(registros);
  if (error) console.error("Erro ao salvar métricas:", error);
  else console.log(`Métricas salvas: ${registros.map(r => r.nome).join(", ")}`);
}

async function carregarHistorico(telefone) {
  try {
    const raw = await redis.get(`historico:${telefone}`);
    if (!raw) return [];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return []; }
}

async function salvarHistorico(telefone, historico) {
  try {
    await redis.set(`historico:${telefone}`, JSON.stringify(historico.slice(-MAX_HISTORICO)), { ex: HISTORICO_TTL });
  } catch (err) { console.log("Erro ao salvar histórico:", err); }
}

async function responderComHistorico(telefone, novaMensagem, imagemData = null) {
  const [historico, historicoSaude] = await Promise.all([
    carregarHistorico(telefone),
    buscarHistoricoSaude(telefone),
  ]);

  const systemCompleto = PROMPT_DOUTORZINHO + gerarContextoHistorico(historicoSaude);

  let novoConteudo;
  if (imagemData) {
    const mimetypeValido = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(imagemData.mimetype)
      ? imagemData.mimetype : "image/jpeg";
    novoConteudo = [
      { type: "image", source: { type: "base64", media_type: mimetypeValido, data: imagemData.base64 } },
      { type: "text", text: novaMensagem || "Analise este exame médico." },
    ];
  } else {
    novoConteudo = novaMensagem;
  }

  historico.push({ role: "user", content: novoConteudo });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemCompleto,
    messages: historico,
  });

  const respostaTexto = response.content[0].text;
  historico.push({ role: "assistant", content: respostaTexto });
  await salvarHistorico(telefone, historico);
  return respostaTexto;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;

    let telefone = body?.phone?.replace(/\D/g, "");
    if (telefone && telefone.startsWith("55") && telefone.length === 12) {
      telefone = telefone.slice(0, 4) + "9" + telefone.slice(4);
    }

    console.log("Telefone formatado:", telefone);

    if (!telefone) return res.status(200).json({ ok: true });
    if (body?.fromMe) return res.status(200).json({ ok: true });

    const messageId = body?.messageId || body?.id || null;
    if (messageId) {
      const salvou = await redis.set(`msg:${messageId}`, "1", { nx: true, ex: 300 });
      if (!salvou) return res.status(200).json({ ok: true });
    }

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
    const isDocumento = body?.type === "document" || body?.document;

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
        const [respostaTexto, metricasExtraidas] = await Promise.all([
          responderComHistorico(telefone, textoRecebido || "Analise este exame médico.", { base64, mimetype }),
          extrairMetricasDeTexto(textoRecebido || "Exame médico em imagem"),
        ]);
        resposta = respostaTexto;
        if (metricasExtraidas.tem_metricas) {
          await salvarMetricas(telefone, metricasExtraidas.metricas, "whatsapp_foto", textoRecebido, metricasExtraidas.data_exame);
        }
      } catch (err) {
        console.error("Erro ao processar imagem:", err);
        resposta = "😕 Tive um problema ao acessar sua imagem. Tenta mandar a foto novamente!";
      }
    } else if (imagemBase64Direto) {
      await enviarMensagem(telefone, "⏳ Recebi seu exame! O Doutorzinho está analisando... aguarda uns 30 segundos 🩺");
      const [respostaTexto, metricasExtraidas] = await Promise.all([
        responderComHistorico(telefone, textoRecebido || "Analise este exame médico.", { base64: imagemBase64Direto, mimetype: imagemMimeDireto }),
        extrairMetricasDeTexto(textoRecebido || ""),
      ]);
      resposta = respostaTexto;
      if (metricasExtraidas.tem_metricas) {
        await salvarMetricas(telefone, metricasExtraidas.metricas, "whatsapp_foto", textoRecebido, metricasExtraidas.data_exame);
      }
    } else if (isDocumento) {
      resposta = `📄 Recebi seu PDF!\n\nPor enquanto analiso melhor por *foto do exame*. Tira uma foto nítida do resultado e manda aqui que eu analiso na hora! 📸`;
    } else if (textoRecebido) {
      const metricasExtraidas = await extrairMetricasDeTexto(textoRecebido);
      if (metricasExtraidas.tem_metricas) {
        await salvarMetricas(telefone, metricasExtraidas.metricas, "whatsapp_texto", textoRecebido, metricasExtraidas.data_exame);
        console.log(`Métricas extraídas do texto: ${metricasExtraidas.metricas.map(m => m.nome).join(", ")}`);
      }
      resposta = await responderComHistorico(telefone, textoRecebido);
    }

    if (resposta) await enviarMensagem(telefone, resposta);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(200).json({ ok: true });
  }
}
