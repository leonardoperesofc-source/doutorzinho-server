import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const META_PIXEL_ID = '26175682082134875';
const META_CAPI_URL = 'https://graph.facebook.com/v19.0/' + META_PIXEL_ID + '/events';

// ========== Utilitarios ==========
function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizarTelefone(tel) {
  if (!tel) return '';
  let t = tel.toString().replace(/\D/g, '');
  if (!t.startsWith('55')) t = '55' + t;
  if (t.length === 12) t = t.slice(0, 4) + '9' + t.slice(4);
  return t;
}

function removerAcentos(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ========== Deteccao flexivel de produtos no payload ==========
function coletarNomes(obj, depth) {
  if (depth === undefined) depth = 0;
  const nomes = [];
  if (!obj || typeof obj !== 'object' || depth > 6) return nomes;
  for (const key in obj) {
    const val = obj[key];
    if (val == null) continue;
    const chaveBaixa = key.toLowerCase();
    const eCampoNome = chaveBaixa === 'name' || chaveBaixa === 'title'
                    || chaveBaixa === 'product_name' || chaveBaixa === 'product'
                    || chaveBaixa === 'description' || chaveBaixa === 'offer_name';
    if (typeof val === 'string' && eCampoNome) {
      nomes.push(val);
    } else if (typeof val === 'object') {
      nomes.push.apply(nomes, coletarNomes(val, depth + 1));
    }
  }
  return nomes;
}

function detectarProdutos(body) {
  const nomes = coletarNomes(body).map(n => removerAcentos(n).toLowerCase());
  const todos = nomes.join(' | ');

  const temPassaporte = todos.includes('passaporte');
  const temVital = todos.includes('vitalic') || todos.includes('vitalici');
  const temAnual = todos.includes('anual') || todos.includes('12 meses');

  return {
    nomesDetectados: nomes,
    temDoutorzinho: todos.includes('doutorzinho'),
    temPassaporteVitalicio: temPassaporte && temVital,
    temPassaporteAnual: temPassaporte && temAnual && !temVital,
    temConjuge: todos.includes('conjuge'),
    temFilhos: todos.includes('filho'),
  };
}

// ========== Meta CAPI ==========
async function dispararEventoMeta(dados) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) { console.warn('[CAPI] META_CAPI_TOKEN nao configurado'); return; }

  const userData = {};
  if (dados.email) userData.em = hash(dados.email);
  if (dados.telefone) userData.ph = hash(dados.telefone.replace(/\D/g, ''));
  if (dados.nome) {
    const partes = dados.nome.trim().split(' ');
    userData.fn = hash(partes[0]);
    if (partes.length > 1) userData.ln = hash(partes.slice(1).join(' '));
  }
  if (dados.ip) userData.client_ip_address = dados.ip;
  if (dados.userAgent) userData.client_user_agent = dados.userAgent;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: 'payt_' + (dados.orderId || Date.now()),
      event_source_url: 'https://seuexamify.com.br',
      action_source: 'website',
      user_data: userData,
      custom_data: {
        value: parseFloat(dados.valor) || 47.00,
        currency: 'BRL',
        content_name: dados.contentName || 'SeuExamify',
        content_type: 'product',
      },
    }],
  };

  try {
    const resp = await fetch(META_CAPI_URL + '?access_token=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.events_received) {
      console.log('[CAPI] Purchase ok | events:', result.events_received, '| order:', dados.orderId);
    } else {
      console.error('[CAPI] Erro:', JSON.stringify(result));
    }
  } catch (e) {
    console.error('[CAPI] Excecao:', e.message);
  }
}

// ========== Mensagens WhatsApp ==========
function montarMsgBoasVindas(nome, produtos) {
  const primeiroNome = nome ? nome.split(' ')[0] : 'por aqui';
  const temPassaporte = produtos.temPassaporteAnual || produtos.temPassaporteVitalicio;
  const soPassaporte = temPassaporte && !produtos.temDoutorzinho;

  if (soPassaporte) {
    // Compra de upsell separada — usuario ja e assinante
    let msg = 'Oi, ' + primeiroNome + '! 🎉\n\n';
    if (produtos.temPassaporteVitalicio) {
      msg += 'Seu *Passaporte de Saúde Vitalício* foi ativado!\n\n';
      msg += 'Agora você tem acesso *PARA SEMPRE* ao seu painel completo: histórico de exames, gráficos de progressão e acompanhamento detalhado da sua saúde ao longo do tempo.\n\n';
    } else {
      msg += 'Seu *Passaporte de Saúde Anual* foi ativado!\n\n';
      msg += 'Agora você tem acesso por 12 meses ao seu painel completo: histórico de exames, gráficos de progressão e acompanhamento detalhado da sua saúde.\n\n';
    }
    msg += '🔗 Acesse agora: *app.seuexamify.com.br*\n';
    msg += '_(Entre com o mesmo e-mail usado na compra)_';
    return msg;
  }

  // Compra principal (Doutorzinho, com ou sem passaporte no mesmo pedido)
  let msg = 'Oi, ' + primeiroNome + '! 👋\n\n';
  msg += 'Seu acesso ao *Doutorzinho* foi liberado! 🎉\n\n';
  msg += 'Pode me mandar a foto ou PDF de qualquer exame aqui mesmo — vou te explicar tudo em 30 segundos. O que está normal, o que merece atenção, e o que perguntar pro médico.\n\n';

  if (produtos.temPassaporteVitalicio) {
    msg += '✨ Você também ativou o *Passaporte de Saúde Vitalício*!\n';
    msg += 'Acesso *PARA SEMPRE* ao seu painel com histórico completo e gráficos de progressão.\n\n';
    msg += '🔗 Acesse: *app.seuexamify.com.br*\n';
    msg += '_(mesmo e-mail da compra)_';
  } else if (produtos.temPassaporteAnual) {
    msg += '✨ Você também ativou o *Passaporte de Saúde Anual*!\n';
    msg += 'Painel completo liberado por 12 meses com histórico e gráficos de progressão.\n\n';
    msg += '🔗 Acesse: *app.seuexamify.com.br*\n';
    msg += '_(mesmo e-mail da compra)_';
  }

  return msg;
}

function montarMsgBumps(nome, produtos) {
  if (!produtos.temConjuge && !produtos.temFilhos) return null;
  const primeiroNome = nome ? nome.split(' ')[0] : '';
  const prefixo = primeiroNome ? primeiroNome + ', ' : '';

  let alvo = '';
  if (produtos.temConjuge && produtos.temFilhos) alvo = '*seu cônjuge e seus filhos*';
  else if (produtos.temConjuge) alvo = '*seu cônjuge*';
  else alvo = '*seus filhos*';

  let msg = '🙌 ' + prefixo + 'você adicionou ' + alvo + ' ao seu plano!\n\n';
  msg += 'Nos próximos dias vou te mandar aqui os detalhes para configurar o acesso e começarem a usar o Doutorzinho também. ';
  msg += 'Enquanto isso, aproveita pra testar mandando qualquer exame aqui! 📸';
  return msg;
}

async function enviarMensagemWhatsApp(telefone, mensagem) {
  const INSTANCE = '3F0FB3E6FACC91802BBCBA665B49BD70';
  const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
  const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
  const url = 'https://api.z-api.io/instances/' + INSTANCE + '/token/' + ZAPI_TOKEN + '/send-text';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN },
      body: JSON.stringify({ phone: telefone, message: mensagem }),
    });
    return await resp.json();
  } catch (e) {
    console.error('[ZAPI] Erro:', e.message);
    return null;
  }
}

// ========== Handler principal ==========
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('[Payt] Payload:', JSON.stringify(body).substring(0, 600));

    const status = body?.data?.status || body?.status || '';
    const email = body?.data?.customer?.email || body?.customer?.email || '';
    const nome = body?.data?.customer?.name || body?.customer?.name || '';
    const telefoneRaw = body?.data?.customer?.phone || body?.customer?.phone || '';
    const valor = body?.data?.amount || body?.amount || '47.00';
    const orderId = body?.data?.id || body?.id || body?.order_id || '';
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
    const userAgent = req.headers['user-agent'] || '';

    const APROVADOS = ['paid','approved','completed','active','PAID','APPROVED','COMPLETED','Completed'];
    if (!APROVADOS.includes(status)) {
      console.log('[Payt] Status nao aprovado, ignorando:', status);
      return res.status(200).json({ ok: true, ignorado: true, status });
    }

    // Detecta quais produtos foram comprados
    const produtos = detectarProdutos(body);
    console.log('[Payt] Produtos detectados:', JSON.stringify({
      doutorzinho: produtos.temDoutorzinho,
      passaporteVitalicio: produtos.temPassaporteVitalicio,
      passaporteAnual: produtos.temPassaporteAnual,
      conjuge: produtos.temConjuge,
      filhos: produtos.temFilhos,
      nomes: produtos.nomesDetectados,
    }));

    // 1. Meta CAPI (nao bloqueia)
    const contentName = produtos.temPassaporteVitalicio ? 'Passaporte Vitalicio'
                      : produtos.temPassaporteAnual ? 'Passaporte Anual'
                      : 'SeuExamify - Doutorzinho';
    dispararEventoMeta({ email, telefone: telefoneRaw, nome, valor, orderId, ip, userAgent, contentName })
      .catch(e => console.error('[CAPI] Erro:', e.message));

    const tel = normalizarTelefone(telefoneRaw);

    // 2. Redis — libera acessos granulares
    if (tel && tel.length >= 12) {
      // Doutorzinho (acesso WhatsApp) — sempre que compra qualquer coisa no funil
      await redis.set('assinante:' + tel, '1');
      console.log('[Redis] Assinante Doutorzinho:', tel);

      // Passaporte (acesso dashboard)
      if (produtos.temPassaporteVitalicio) {
        await redis.set('passaporte:' + tel, 'vitalicio');
        console.log('[Redis] Passaporte VITALICIO ativado:', tel);
      } else if (produtos.temPassaporteAnual) {
        const expira = new Date();
        expira.setFullYear(expira.getFullYear() + 1);
        const dataStr = expira.toISOString().split('T')[0];
        await redis.set('passaporte:' + tel, 'anual:' + dataStr);
        console.log('[Redis] Passaporte ANUAL ativado:', tel, '| expira:', dataStr);
      }

      // Order bumps (registra intencao de adicionar conjuge/filhos)
      if (produtos.temConjuge || produtos.temFilhos) {
        const bumps = {
          conjuge: !!produtos.temConjuge,
          filhos: !!produtos.temFilhos,
          data: new Date().toISOString(),
          order_id: orderId || null,
        };
        await redis.set('bumps:' + tel, JSON.stringify(bumps));
        console.log('[Redis] Order bumps salvos:', JSON.stringify(bumps));
      }
    }

    // 3. Supabase — salva/atualiza usuario com plano detectado
    if (email) {
      const planoFinal = produtos.temPassaporteVitalicio ? 'passaporte_vitalicio'
                       : produtos.temPassaporteAnual ? 'passaporte_anual'
                       : 'doutorzinho';

      const upsertData = {
        email,
        nome: nome || null,
        telefone: tel || null,
        plano: planoFinal,
        ordem_id: orderId || null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('usuarios').upsert(upsertData, { onConflict: 'email' });
      if (error) console.error('[Supabase] Erro:', error.message);
      else console.log('[Supabase] Usuario salvo:', email, '| plano:', planoFinal);
    }

    // 4. Z-API — mensagens personalizadas
    if (tel && tel.length >= 12) {
      const msgPrincipal = montarMsgBoasVindas(nome, produtos);
      const resp1 = await enviarMensagemWhatsApp(tel, msgPrincipal);
      console.log('[ZAPI] Msg principal:', JSON.stringify(resp1).substring(0, 100));

      const msgBumps = montarMsgBumps(nome, produtos);
      if (msgBumps) {
        await new Promise(r => setTimeout(r, 2500));
        const resp2 = await enviarMensagemWhatsApp(tel, msgBumps);
        console.log('[ZAPI] Msg bumps:', JSON.stringify(resp2).substring(0, 100));
      }
    }

    return res.status(200).json({
      ok: true,
      processado: true,
      order: orderId,
      produtos: {
        doutorzinho: produtos.temDoutorzinho,
        passaporte_vitalicio: produtos.temPassaporteVitalicio,
        passaporte_anual: produtos.temPassaporteAnual,
        conjuge: produtos.temConjuge,
        filhos: produtos.temFilhos,
      },
    });

  } catch (err) {
    console.error('[Payt] Erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
