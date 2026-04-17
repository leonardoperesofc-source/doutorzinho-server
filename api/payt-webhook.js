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

function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function dispararEventoMeta({ email, telefone, nome, valor, orderId, ip, userAgent }) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) { console.warn('[CAPI] META_CAPI_TOKEN nao configurado'); return; }

  const userData = {};
  if (email) userData.em = hash(email);
  if (telefone) userData.ph = hash(telefone.replace(/\D/g, ''));
  if (nome) {
    const partes = nome.trim().split(' ');
    userData.fn = hash(partes[0]);
    if (partes.length > 1) userData.ln = hash(partes.slice(1).join(' '));
  }
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: 'payt_' + (orderId || Date.now()),
      event_source_url: 'https://seuexamify.com.br',
      action_source: 'website',
      user_data: userData,
      custom_data: {
        value: parseFloat(valor) || 47.00,
        currency: 'BRL',
        content_name: 'SeuExamify - Passaporte de Saude',
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
      console.log('[CAPI] Purchase ok | events:', result.events_received, '| order:', orderId);
    } else {
      console.error('[CAPI] Erro:', JSON.stringify(result));
    }
  } catch (e) {
    console.error('[CAPI] Excecao:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('[Payt] Payload:', JSON.stringify(body).substring(0, 400));

    const status   = body?.data?.status   || body?.status   || '';
    const email    = body?.data?.customer?.email || body?.customer?.email || '';
    const nome     = body?.data?.customer?.name  || body?.customer?.name  || '';
    const telefone = body?.data?.customer?.phone || body?.customer?.phone || '';
    const valor    = body?.data?.amount || body?.amount || '47.00';
    const orderId  = body?.data?.id || body?.id || body?.order_id || '';
    const ip       = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
    const userAgent = req.headers['user-agent'] || '';

    console.log('[Payt] status:', status, '| email:', email, '| order:', orderId);

    const APROVADOS = ['paid','approved','completed','active','PAID','APPROVED','COMPLETED','Completed'];
    if (!APROVADOS.includes(status)) {
      console.log('[Payt] Status nao aprovado, ignorando:', status);
      return res.status(200).json({ ok: true, ignorado: true, status });
    }

    // 1. CAPI Meta (nao bloqueia)
    dispararEventoMeta({ email, telefone, nome, valor, orderId, ip, userAgent })
      .catch(e => console.error('[CAPI] Erro:', e.message));

    // 2. Redis — adiciona assinante
    let tel = telefone ? telefone.replace(/\D/g, '') : '';
    if (tel && !tel.startsWith('55')) tel = '55' + tel;
    if (tel.length === 12) tel = tel.slice(0,4) + '9' + tel.slice(4);

    if (tel && tel.length >= 12) {
      await redis.set('assinante:' + tel, '1');
      console.log('[Redis] Assinante:', tel);
    }

    // 3. Supabase — salva usuario
    if (email) {
      const { error } = await supabase.from('usuarios').upsert({
        email,
        nome: nome || null,
        telefone: tel || null,
        plano: 'pagante',
        ordem_id: orderId || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      if (error) console.error('[Supabase] Erro:', error.message);
      else console.log('[Supabase] Usuario salvo:', email);
    }

    // 4. Z-API — mensagem boas-vindas
    if (tel && tel.length >= 12) {
      const INSTANCE = '3F0FB3E6FACC91802BBCBA665B49BD70';
      const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
      const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
      const primeiroNome = nome ? nome.split(' ')[0] : 'por aqui';

      const msg = 'Oi, ' + primeiroNome + '! \uD83D\uDC4B\n\n'
        + 'Seu acesso ao *Doutorzinho* foi liberado! \uD83C\uDF89\n\n'
        + 'Pode me mandar a foto ou PDF de qualquer exame aqui mesmo — '
        + 'vou te explicar tudo em 30 segundos.\n\n'
        + 'Para acompanhar seu hist\u00f3rico completo, acesse:\n'
        + '*app.seuexamify.com.br*\n\n'
        + '_(Entre com o mesmo e-mail usado na compra)_';

      const zapiUrl = 'https://api.z-api.io/instances/' + INSTANCE + '/token/' + ZAPI_TOKEN + '/send-text';
      try {
        const zapiResp = await fetch(zapiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN },
          body: JSON.stringify({ phone: tel, message: msg }),
        });
        const zapiData = await zapiResp.json();
        console.log('[ZAPI] Resposta:', JSON.stringify(zapiData).substring(0, 100));
      } catch (e) {
        console.error('[ZAPI] Erro:', e.message);
      }
    }

    return res.status(200).json({ ok: true, processado: true, order: orderId });

  } catch (err) {
    console.error('[Payt] Erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
}