const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Meta CAPI ────────────────────────────────────────────────
const META_PIXEL_ID   = '26175682082134875';
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN; // variavel de ambiente no Vercel
const META_CAPI_URL   = 'https://graph.facebook.com/v19.0/' + META_PIXEL_ID + '/events';

// Normaliza e hasheia com SHA-256 (padrao Meta)
function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// Dispara evento Purchase para a CAPI da Meta
async function dispararEventoMeta({ email, telefone, nome, valor, orderId, ip, userAgent, fbp, fbc }) {
  if (!META_CAPI_TOKEN) {
    console.warn('META_CAPI_TOKEN nao configurado — pulando CAPI');
    return;
  }

  // Monta user_data com todos os identificadores disponiveis (hasheados)
  const userData = {
    em: hash(email),
    ph: hash(telefone ? telefone.replace(/\D/g, '') : null),
    fn: hash(nome ? nome.split(' ')[0] : null),
    ln: hash(nome && nome.split(' ').length > 1 ? nome.split(' ').slice(1).join(' ') : null),
    client_ip_address: ip || undefined,
    client_user_agent: userAgent || undefined,
    fbp: fbp || undefined,   // cookie _fbp do browser (se disponivel via UTMify/GTM)
    fbc: fbc || undefined,   // cookie _fbc / parametro fbclid
  };

  // Remove campos undefined
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: orderId || ('pay_' + Date.now()), // deduplicacao com pixel browser
        event_source_url: 'https://seuexamify.com.br',
        action_source: 'website',
        user_data: userData,
        custom_data: {
          value: parseFloat(valor) || 47.00,
          currency: 'BRL',
          content_name: 'SeuExamify - Passaporte de Saude',
          content_type: 'product',
          order_id: orderId || undefined,
        },
      }
    ],
    test_event_code: process.env.META_TEST_EVENT_CODE || undefined, // remove em producao
  };

  // Remove test_event_code se nao definido
  if (!payload.test_event_code) delete payload.test_event_code;

  try {
    const resp = await fetch(META_CAPI_URL + '?access_token=' + META_CAPI_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.events_received) {
      console.log('[CAPI] Purchase disparado com sucesso | events_received:', result.events_received, '| order:', orderId);
    } else {
      console.error('[CAPI] Erro na resposta:', JSON.stringify(result));
    }
  } catch (err) {
    console.error('[CAPI] Erro ao disparar evento:', err.message);
  }
}
// ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('[Payt Webhook] Payload recebido:', JSON.stringify(body).substring(0, 300));

    // Extrai dados do payload do Payt
    const status   = body?.data?.status || body?.status || '';
    const email    = body?.data?.customer?.email || body?.customer?.email || '';
    const nome     = body?.data?.customer?.name  || body?.customer?.name  || '';
    const telefone = body?.data?.customer?.phone || body?.customer?.phone || '';
    const valor    = body?.data?.amount || body?.amount || '47.00';
    const orderId  = body?.data?.id || body?.id || body?.order_id || '';

    // Dados de tracking (enviados pelo browser via UTMify/pixel se disponiveis no payload)
    const ip        = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    const fbp       = body?.data?.fbp || body?.fbp || '';
    const fbc       = body?.data?.fbc || body?.fbc || body?.data?.fbclid || '';

    console.log('[Payt Webhook] status:', status, '| email:', email, '| order:', orderId);

    // So processa se pagamento aprovado
    const aprovado = ['paid', 'approved', 'completed', 'active', 'PAID', 'APPROVED', 'COMPLETED'].includes(status);
    if (!aprovado) {
      console.log('[Payt Webhook] Status nao aprovado, ignorando:', status);
      return res.status(200).json({ ok: true, ignorado: true, status });
    }

    // ── 1. Dispara CAPI da Meta (nao bloqueia o resto) ──
    dispararEventoMeta({ email, telefone, nome, valor, orderId, ip, userAgent, fbp, fbc })
      .catch(e => console.error('[CAPI] Erro nao bloqueante:', e.message));

    // ── 2. Adiciona assinante no Redis ──
    let telFormatado = telefone ? telefone.replace(/\D/g, '') : '';
    if (telFormatado && !telFormatado.startsWith('55')) telFormatado = '55' + telFormatado;

    if (telFormatado && telFormatado.length >= 12) {
      await redis.set('assinante:' + telFormatado, '1');
      console.log('[Redis] Assinante adicionado:', telFormatado);
    }

    // ── 3. Salva lead no Supabase ──
    if (email) {
      const { error: dbErr } = await supabase.from('usuarios').upsert({
        email,
        nome: nome || null,
        telefone: telFormatado || null,
        plano: 'pagante',
        ordem_id: orderId || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      if (dbErr) console.error('[Supabase] Erro ao salvar usuario:', dbErr.message);
      else console.log('[Supabase] Usuario salvo/atualizado:', email);
    }

    // ── 4. Envia mensagem de boas-vindas via Z-API ──
    if (telFormatado && telFormatado.length >= 12) {
      const INSTANCE = '3F0FB3E6FACC91802BBCBA665B49BD70';
      const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
      const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

      const msgBoasVindas =
        'Oi, ' + (nome ? nome.split(' ')[0] : 'bem-vindo') + '! 👋\n\n' +
        'Seu acesso ao *Doutorzinho* foi liberado! 🎉\n\n' +
        'Pode me mandar a foto ou PDF de qualquer exame aqui mesmo — vou te explicar tudo em 30 segundos.\n\n' +
        'E para acompanhar seu hist\u00f3rico completo de sa\u00fade, acesse sua dashboard:\n' +
        '*app.seuexamify.com.br*\n\n' +
        '_(Entre com o mesmo e-mail usado na compra)_';

      const zapiUrl = 'https://api.z-api.io/instances/' + INSTANCE + '/token/' + ZAPI_TOKEN + '/send-text';
      const zapiResp = await fetch(zapiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': CLIENT_TOKEN,
        },
        body: JSON.stringify({ phone: telFormatado, message: msgBoasVindas }),
      });
      const zapiData = await zapiResp.json();
      console.log('[Z-API] Boas-vindas enviado:', JSON.stringify(zapiData).substring(0, 100));
    }

    return res.status(200).json({ ok: true, processado: true, order: orderId });

  } catch (err) {
    console.error('[Payt Webhook] Erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
};