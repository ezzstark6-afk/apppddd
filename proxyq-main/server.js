require('dotenv').config();
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();

// -----------------------------------------------------------------
// PORTA: no Shard Cloud, ao contr�rio de Render/Railway/Heroku, a
// documenta��o oficial exige a porta 80 para aplica��es web
// (docs.shardcloud.app/tutorials/api/express). Para teste local,
// defina PORT=3000 no seu .env.
// -----------------------------------------------------------------
const PORT = process.env.PORT || 80;

// Inicia o bot de status e logs (opcional � s� roda se BOT_TOKEN estiver definido)
let bot = { logTransmissaoIniciada: () => {}, logTransmissaoEncerrada: () => {}, logSalaCriada: () => {}, logSalaFechada: () => {} };
try { bot = require('./bot'); } catch (e) { console.warn('[bot] N�o foi poss�vel iniciar o bot:', e.message); }

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
// Origem p�blica do site (onde share.html abre fora do Discord).
// Se n�o definir, usa o host da pr�pria requisi��o.
const SHARE_ORIGIN = process.env.SHARE_ORIGIN || '';
// Segredo para assinar os tokens (JWT HS256). Se n�o definir, gera um
// aleat�rio por processo � tokens morrem quando o app reinicia.
const TOKEN_SECRET =
  process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[aviso] CLIENT_ID ou CLIENT_SECRET n�o definidos no .env � a troca de token OAuth vai falhar.');
}

// -----------------------------------------------------------------
// Webhook de logs � envia eventos para um canal do Discord.
// Defina LOG_WEBHOOK no .env para ativar.
// -----------------------------------------------------------------
const LOG_WEBHOOK = process.env.LOG_WEBHOOK || '';

function logar(msg) {
  if (!LOG_WEBHOOK) return;
  try {
    const url = new URL(LOG_WEBHOOK);
    const body = JSON.stringify({ content: msg });
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      () => {},
    );
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function horario() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
if (!process.env.TOKEN_SECRET) {
  console.warn('[aviso] TOKEN_SECRET n�o definido no .env � usando segredo tempor�rio desta execu��o.');
}

// -----------------------------------------------------------------
// O proxy da Activity encaminha o caminho com /.proxy intacto — foi por
// isso que o handler de upgrade lá embaixo precisou removê-lo para achar
// o /ws. Com o HTTP não era diferente, só não estava tratado: o
// index.html prefixa todo fetch com /.proxy quando roda dentro do
// Discord, e POST /.proxy/api/session não casa com rota nenhuma. Cai no
// 404 antes de a atividade conseguir abrir a sessão.
// -----------------------------------------------------------------
app.use((req, res, next) => {
  const limpo = req.url.replace(/^\/\.proxy(?=[/?]|$)/, '');
  if (limpo !== req.url) req.url = limpo.startsWith('/') ? limpo : '/' + limpo;
  next();
});

app.use(express.json({ limit: '256kb' }));

// CORS + headers obrigat�rios para Discord Activity
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Cache-Control', 'no-store');

  // Permite que o Discord carregue este servidor dentro do iframe da Activity.
  // Sem este header alguns clientes do Discord recusam o carregamento.
  res.header(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://discord.com https://canary.discord.com https://ptb.discord.com https://*.discordsays.com",
  );

  // Remove qualquer X-Frame-Options que o Express ou o host possam adicionar �
  // ele conflita com o frame-ancestors acima e bloqueia o iframe do Discord.
  res.removeHeader('X-Frame-Options');

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// -----------------------------------------------------------------
// Tokens: <payloadBase64url>.<assinaturaHMAC-SHA256> � mesmo formato
// da refer�ncia, cujo share.js l� o payload no primeiro segmento.
// Payload com {room, uid, name, av, guild, channel, role[, exp]}.
// A verifica��o aceita tamb�m o formato JWT padr�o (header.payload.sig).
// -----------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(payloadPart) {
  return crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payloadPart)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const body = parts[parts.length - 2];
  const sig = parts[parts.length - 1];
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// Salas: uma por guild:channel. Guarda transmissores (slots),
// visualizadores e conex�es de controle da p�gina de captura.
// -----------------------------------------------------------------

const rooms = new Map(); // roomId -> room

const ROOM_TTL_MS = 5 * 60 * 1000;

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      broadcasters: new Map(), // slot -> broadcaster
      viewers: new Set(),
      controls: new Set(),
      nextSlot: 1,
      emptyTimer: null,
    };
    rooms.set(roomId, room);
    bot.logSalaCriada({ roomId });
  }
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
  return room;
}

/**
 * Agenda o fim da sala quando não há mais ninguém para servir.
 *
 * A aba de captura não conta como vida. Ela existe para servir a sala, não o
 * contrário: sozinha é uma janela órfã, segurando a permissão de captura de
 * tela de alguém e transmitindo para ninguém. Enquanto ela contava, o
 * temporizador nunca chegava a ser armado e a sala vivia para sempre.
 */
function maybeCloseRoom(room) {
  if (room.broadcasters.size > 0 || room.viewers.size > 0) return;

  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => fecharSala(room), ROOM_TTL_MS);
}

/**
 * Encerra a sala e avisa quem ficou.
 *
 * O aviso é a única forma de a aba de captura saber que acabou. Ela é uma
 * página top-level, aberta pelo navegador do sistema — fechada a atividade,
 * nada mais a alcança a não ser esta conexão. Sem o recado ela fica aberta
 * indefinidamente, e é uma aba que pode estar segurando a tela inteira de
 * alguém.
 *
 * O share.js e o index.html tratam `room-gone` desde sempre; era o servidor
 * que nunca chegava a mandar.
 */
function fecharSala(room) {
  // Já substituída por outra sala com o mesmo id: esta não é mais a vigente.
  if (rooms.get(room.id) !== room) return;

  rooms.delete(room.id);
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;

  const sockets = [
    ...room.controls,
    ...[...room.viewers].map((v) => v.ws),
    ...[...room.broadcasters.values()].map((b) => b.ws),
  ];
  for (const ws of sockets) safeSend(ws, { type: 'room-gone' });

  // Fechar no mesmo tique descartaria o aviso junto com o buffer de saída.
  setTimeout(() => {
    for (const ws of sockets) {
      try {
        ws.close(4004, 'sala encerrada');
      } catch {}
    }
  }, 1000);

  bot.logSalaFechada({ roomId: room.id });
}

function activeStreams(room) {
  const out = [];
  for (const b of room.broadcasters.values()) {
    if (!b.active) continue;
    out.push({
      slot: b.slot,
      userId: b.userId,
      name: b.name,
      fonte: b.fonte,
      watchers: room.viewers.size,
      config: b.config,
      audioConfig: b.audioConfig,
    });
  }
  return out;
}

function participants(room) {
  const seen = new Map();
  for (const b of room.broadcasters.values()) seen.set(b.userId, { name: b.name, av: b.av, banner: b.banner, accentColor: b.accentColor });
  for (const v of room.viewers.values())      seen.set(v.userId, { name: v.name, av: v.av, banner: v.banner, accentColor: v.accentColor });
  return [...seen.entries()].map(([id, info]) => ({ id, ...info }));
}


// Manda state completo para TODOS � viewers e broadcasters.
// Broadcasters tamb�m precisam saber quem entrou/saiu da sala.
function sendStateToAll(room) {
  const state = {
    type: 'state',
    participants: participants(room),
    abas: [],
    room: null,
    streams: activeStreams(room),
  };
  for (const v of room.viewers)              safeSend(v.ws, state);
  for (const b of room.broadcasters.values()) safeSend(b.ws, state);
}

// Envia contagem de viewers apenas para os broadcasters (n�o altera participantes)
function sendViewersCount(room) {
  const msg = { type: 'viewers-count', viewers: room.viewers.size };
  for (const b of room.broadcasters.values()) safeSend(b.ws, msg);
}

function broadcastStreamStart(room, b) {
  const msg = { type: 'stream-start', slot: b.slot, userId: b.userId, name: b.name, fonte: b.fonte };
  for (const v of room.viewers) safeSend(v.ws, msg);
}

function broadcastStreamStop(room, slot) {
  const msg = { type: 'stream-stop', slot };
  for (const v of room.viewers) safeSend(v.ws, msg);
}

function forwardConfig(room, b, kind) {
  const msg = { type: kind, slot: b.slot, config: kind === 'config' ? b.config : b.audioConfig };
  for (const v of room.viewers) safeSend(v.ws, msg);
}

const WS_OPEN = 1; // ws.ReadyState.Open � evita depender do global WebSocket

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

// -----------------------------------------------------------------
// APIs REST
// -----------------------------------------------------------------

function discordApi(pathName, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'discord.com',
        path: pathName,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Resposta inv�lida do Discord'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Timeout no Discord')));
    req.end();
  });
}

function publicOrigin(req) {
  if (SHARE_ORIGIN) return SHARE_ORIGIN.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

// API: Token exchange (OAuth)
app.post('/api/token', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Servidor sem CLIENT_ID/CLIENT_SECRET configurados' });
  }

  const postData = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
  }).toString();

  const request = https.request(
    {
      hostname: 'discord.com',
      path: '/api/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    },
    (response) => {
      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return res.status(400).json(json);
          res.json({ access_token: json.access_token });
        } catch {
          res.status(500).json({ error: 'Parse error' });
        }
      });
    },
  );
  request.on('error', () => res.status(500).json({ error: 'Request failed' }));
  request.write(postData);
  request.end();
});

// API: Sess�o � valida o access_token no Discord e devolve os tokens
// (visualizador + transmissor) e a URL da p�gina de captura.
app.post('/api/session', async (req, res) => {
  const { access_token, guild_id, channel_id } = req.body || {};
  if (!access_token) return res.status(400).json({ error: 'access_token required' });

  let user;
  try {
    user = await discordApi('/api/users/@me', access_token);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao validar token no Discord: ' + e.message });
  }
  if (!user || !user.id) return res.status(401).json({ error: 'Token inv�lido' });

  const name    = user.global_name || user.username || 'Convidado';
  const guild   = guild_id   ? String(guild_id)   : null;
  const channel = channel_id ? String(channel_id) : null;
  const roomId  = guild && channel ? `call-${guild}-${channel}` : `user-${user.id}`;

  // banner � hash do banner; accent_color � inteiro RGB
  const banner       = user.banner       || '';
  const accentColor  = user.accent_color != null ? user.accent_color : null;

  const base = {
    room: roomId, uid: user.id, name,
    av: user.avatar || '',
    banner, accentColor,
    guild: guild || '', channel: channel || '',
  };

  getRoom(roomId); // garante que a sala exista desde j�

  res.json({
    roomId,
    user: { id: user.id, name, av: user.avatar, banner, accentColor },
    viewerToken:      signToken({ ...base, role: 'viewer' }),
    broadcasterToken: signToken({ ...base, role: 'broadcaster' }),
    shareUrl: `${publicOrigin(req)}/share.html`,
  });
});

// API: Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// API: Busca canal de voz do usuário via bot
app.post('/api/voice-channel', async (req, res) => {
  const { access_token, guild_id, user_id } = req.body || {};
  if (!access_token || !guild_id || !user_id) {
    return res.status(400).json({ error: 'access_token, guild_id e user_id são obrigatórios' });
  }
  // Valida o token chamando a API do Discord
  let user;
  try {
    user = await discordApi('/api/users/@me', access_token);
    if (!user?.id) throw new Error('Token inválido');
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  // Busca canal de voz via bot
  const channel = await bot.getVoiceChannel(guild_id, user_id).catch(() => null);
  if (!channel) {
    return res.status(404).json({ error: 'Você não está em nenhum canal de voz neste servidor.' });
  }
  res.json({ channel });
});

// API: Inicia a Activity no canal de voz via bot (usando HTTP API do Discord)
app.post('/api/start-activity', async (req, res) => {
  const { access_token, guild_id, channel_id, user_id } = req.body || {};
  if (!access_token || !guild_id || !channel_id || !user_id) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }
  // Valida token
  try {
    const u = await discordApi('/api/users/@me', access_token);
    if (!u?.id) throw new Error('inválido');
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  // Cria invite de Activity via API REST do Discord usando o bot token
  if (!process.env.BOT_TOKEN) {
    return res.status(503).json({ error: 'Bot não configurado' });
  }
  try {
    const body = JSON.stringify({
      max_age: 86400,
      max_uses: 0,
      target_type: 2,                       // 2 = embedded application
      target_application_id: CLIENT_ID,     // ID da sua Activity
    });
    const invite = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'discord.com',
        path: `/api/v10/channels/${channel_id}/invites`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${process.env.BOT_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try { resolve({ status: r.statusCode, data: JSON.parse(d) }); }
          catch { reject(new Error('Parse error')); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    console.log('[start-activity] Discord respondeu:', invite.status, JSON.stringify(invite.data));

    // Resposta de erro do Discord tem statusCode >= 400
    if (invite.status >= 400) {
      const msg = invite.data?.message || invite.data?.error || 'Falha ao criar invite';
      return res.status(500).json({ error: `Discord: ${msg} (código ${invite.data?.code || invite.status})` });
    }

    res.json({ invite_url: `https://discord.gg/${invite.data.code}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Criar sala anônima (para a landing page)
app.post('/api/room', (req, res) => {
  const roomId = 'public-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  getRoom(roomId);
  const base = { room: roomId, uid: 'anon', name: 'Anônimo', av: '', banner: '', accentColor: null, guild: '', channel: '' };
  res.json({
    roomId,
    viewerToken:      signToken({ ...base, role: 'viewer' }),
    broadcasterToken: signToken({ ...base, role: 'broadcaster' }),
    shareUrl: `${publicOrigin(req)}/share.html`,
  });
});

// -----------------------------------------------------------------
// Assistente LAST — proxy para a API da Groq (a chave nunca vai pro
// front-end, fica só aqui no servidor). Defina GROQ_API_KEY no seu
// .env; o valor abaixo é só um fallback pra não travar caso esqueça.
// -----------------------------------------------------------------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'openai/gpt-oss-120b';

const ASSISTANT_SYSTEM_PROMPT = `Você é o Assistente LAST — o assistente de suporte do site Last PVP / Last Transmissões, uma plataforma para compartilhar tela ou câmera ao vivo dentro do Discord (via Discord Activity).

## Como o site funciona de verdade (use isso pra responder, não invente nada além disso)
1. Salas: o site não tem botão de criar sala. A sala é criada automaticamente quando alguém inicia a Activity pelo Discord (card "Iniciar no Discord"); os participantes entram pela call do servidor.
2. Entrar via Discord: tem um card "Iniciar no Discord" na página com 2 passos:
   - Passo 1: clicar em "Conectar Discord" no topo da página pra autenticar (pega nome e foto automaticamente, sem senha e sem cadastro).
   - Passo 2: depois de conectado, o sistema verifica a cada 5 segundos se a pessoa entrou em um canal de voz no Discord. O botão só libera quando ela está de fato em um canal de voz — se não achar nenhum canal, é porque ela não está em nenhum, então precisa entrar em um canal de voz no servidor do Discord.
   - Depois disso, clicar em "Conectar bot" inicia a Activity dentro do canal de voz e abre um convite.
3. Transmitir: dentro da Activity (já dentro do Discord), a pessoa clica no ícone de tela ou câmera pra escolher o que compartilhar (janela, aba ou câmera).
4. Várias pessoas podem transmitir ao mesmo tempo, e a transmissão vai direto entre os participantes (baixa latência).

## Como responder
- Seja EXPLICATIVO e didático: explique o passo a passo de verdade, com uma frase de contexto antes de cada passo, como se estivesse ensinando alguém que nunca usou o site.
- Use frases curtas e claras. Quando fizer sentido, numere os passos (1, 2, 3) em vez de escrever tudo em um parágrafo só.
- Nunca invente comando, funcionalidade, preço, plano ou botão que não existam. Se não souber a resposta com certeza, diga que não tem certeza e sugira falar com a equipe, em vez de chutar.
- Não fale bobagem nem enrole: vá direto ao que a pessoa perguntou.

## O que você NUNCA pode falar sobre
- Comandos internos do bot do Discord, comandos de administração/moderação, tokens, chaves de API, variáveis de ambiente, código-fonte, banco de dados ou qualquer detalhe técnico interno do servidor.
- Nada que não seja sobre o site Last PVP / Last Transmissões. Se perguntarem algo fora desse assunto, explique educadamente que você só pode ajudar com dúvidas do Last e volte o foco pra isso.
- Nunca finja saber algo que não está descrito acima.

Responda sempre em português do Brasil, num tom simpático e direto.`;

const assistantHistory = new Map(); // sessão simples em memória, por IP

function callGroq(messages) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.3, max_tokens: 700 });
    const request = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': 'Bearer ' + GROQ_API_KEY,
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (response.statusCode >= 400) return reject(new Error(json.error?.message || 'Groq error ' + response.statusCode));
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
}

app.post('/api/assistant', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      console.error('[assistant] GROQ_API_KEY não definido no .env');
      return res.status(500).json({ error: 'Assistente não configurado no servidor (GROQ_API_KEY ausente).' });
    }
    const message = String((req.body || {}).message || '').slice(0, 1000).trim();
    if (!message) return res.status(400).json({ error: 'Mensagem vazia.' });

    const key = req.ip || 'anon';
    const history = assistantHistory.get(key) || [];
    history.push({ role: 'user', content: message });

    const messages = [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }].concat(history.slice(-10));

    const data = await callGroq(messages);
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim()
      || 'Desculpa, não consegui responder agora.';

    history.push({ role: 'assistant', content: reply });
    assistantHistory.set(key, history.slice(-10));

    res.json({ reply });
  } catch (err) {
    console.error('[assistant] Erro:', err.message);
    res.status(502).json({ error: 'Assistente indisponível no momento.' });
  }
});

// Static files — desativa o index automático para que o fallback abaixo controle a rota /
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Landing page — HTML inline para não depender de arquivo externo
const LANDING_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Last PVP · Transmissões</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Agdasima:wght@400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="preload" href="/assets/landing/bg.png" as="image">
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{min-height:100%;scroll-behavior:smooth;}

    /* ── Keyframes ── */
    @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
    @keyframes slideUp  { from{opacity:0;transform:translateY(28px)} to{opacity:1;transform:translateY(0)} }
    @keyframes scaleIn  { from{opacity:0;transform:scale(.7)} to{opacity:1;transform:scale(1)} }
    @keyframes lineGrow { from{transform:scaleX(0)} to{transform:scaleX(1)} }

    /* Tela de splash — cobre tudo e desaparece */
    .splash{
      position:fixed;inset:0;z-index:100;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
      background:#0d0d0f;
      animation:fadeIn .01s forwards;
      pointer-events:none;
    }
    .splash.out{
      animation:fadeIn .5s reverse forwards;
      animation-delay:.1s;
    }
    .splash-logo{
      width:72px;height:72px;border-radius:18px;object-fit:contain;
      animation:scaleIn .5s cubic-bezier(.34,1.56,.64,1) forwards;
    }
    .splash-bar{
      width:60px;height:2px;background:#0F49F8;border-radius:2px;
      transform-origin:left;
      animation:lineGrow .6s .3s cubic-bezier(.4,0,.2,1) forwards;
      transform:scaleX(0);
    }

    /* Elementos da página entram em sequência */
    .anim-1{opacity:0;animation:slideUp .55s .65s ease forwards;}
    .anim-2{opacity:0;animation:slideUp .55s .8s  ease forwards;}
    .anim-3{opacity:0;animation:slideUp .55s .95s ease forwards;}
    .anim-4{opacity:0;animation:slideUp .55s 1.1s ease forwards;}
    .anim-5{opacity:0;animation:slideUp .55s 1.25s ease forwards;}
    .anim-6{opacity:0;animation:slideUp .55s 1.4s ease forwards;}
    .topbar{opacity:0;animation:fadeIn .4s .6s ease forwards;}
    .bg    {opacity:0;animation:fadeIn .8s .2s ease forwards;}
    body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:#0d0d0f;color:#f2f3f5;
      cursor:default;user-select:none;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;}
    input,textarea{user-select:text;-webkit-user-select:text;-moz-user-select:text;cursor:text;}

    /* ── Fundo ── */
    .bg{position:fixed;inset:0;z-index:0;pointer-events:none;
      background-color:#0d0d0f;
      background-image:linear-gradient(to right,rgba(8,9,12,.96) 35%,rgba(8,9,12,.6) 65%,rgba(8,9,12,.15) 100%),
      url('/assets/landing/bg.png');
      background-size:cover;background-position:center;}
    .bg-fade{position:fixed;bottom:0;left:0;right:0;height:260px;z-index:0;pointer-events:none;
      background:linear-gradient(0deg,#0d0d0f 0%,transparent 100%);}

    /* ── Topbar ── */
    .topbar{position:fixed;top:0;left:0;right:0;z-index:20;
      display:flex;align-items:center;justify-content:space-between;
      padding:14px 40px;
      background:linear-gradient(180deg,rgba(8,9,12,.7) 0%,transparent 100%);
      backdrop-filter:blur(0px);}
    .topbar-left{display:flex;align-items:center;gap:10px;}
    .topbar-logo{width:30px;height:30px;border-radius:7px;object-fit:contain;}
    .topbar-name{font-family:'Agdasima',sans-serif;font-size:.95rem;font-weight:700;color:#fff;letter-spacing:.04em;text-transform:uppercase;}
    .topbar-sep{width:1px;height:14px;background:rgba(255,255,255,.15);}
    .topbar-sub{font-family:'Agdasima',sans-serif;font-size:.8rem;color:rgba(255,255,255,.35);}
    .btn-discord{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;
      background:#0F49F8;border:none;border-radius:999px;color:#fff;font-size:.8rem;
      font-weight:700;cursor:pointer;box-shadow:0 2px 7px rgba(15,73,248,.4);
      transition:transform .15s,box-shadow .15s;}
    .btn-discord:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(15,73,248,.5);}
    .btn-discord svg{width:17px;height:17px;fill:#fff;flex-shrink:0;}
    .user-pill{display:none;align-items:center;gap:8px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
      border-radius:999px;padding:4px 14px 4px 4px;}
    .user-pill.visible{display:flex;}
    .user-pill img{width:26px;height:26px;border-radius:50%;object-fit:cover;}
    .user-pill span{font-size:.8rem;font-weight:600;color:#f2f3f5;}

    /* ── Hero ── */
    .hero{position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;
      flex-wrap:wrap;gap:clamp(100px,20vw,400px);justify-content:space-between;
      padding:110px 3vw 70px;}
    .hero-content{display:flex;flex-direction:column;gap:20px;max-width:420px;flex:1 1 360px;}
    .eyebrow{display:inline-flex;align-items:center;gap:10px;
      font-size:.75rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
      color:#e9edf2;}
    .eyebrow-dot{width:3px;height:15px;border-radius:999px;background:#0F49F8;
      box-shadow:0 0 12px rgba(1,134,209,.65);}
    .eyebrow-sep{padding-left:10px;margin-left:2px;border-left:1px solid rgba(15,73,248,.26);
      font-size:.74rem;letter-spacing:0;text-transform:none;color:#6f5a5a;}
    h1{font-size:clamp(1.9rem,4vw,2.6rem);font-weight:700;line-height:1.12;
      letter-spacing:-1.05px;
      background:linear-gradient(142deg,#051554 15%,#0F49F8 45%,#8ab4ff 89%);
      -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
      filter:drop-shadow(0 2px 18px rgba(4,8,13,.26));}
    .desc{font-size:.9rem;color:#a5aebd;line-height:1.5;max-width:460px;}

    /* Features */
    .features{display:flex;flex-direction:column;gap:12px;padding-top:4px;}
    .feature{display:flex;align-items:center;gap:11px;font-size:.8rem;color:#8f7979;line-height:1.5;}
    .feature-icon{width:28px;height:28px;border-radius:7px;background:rgba(34,20,20,.5);
      border:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;flex-shrink:0;backdrop-filter:blur(10px);}
    .feature-icon img{width:15px;height:15px;}

    /* Stats */
    .stats{display:flex;gap:28px;padding-top:4px;}
    .stat{display:flex;flex-direction:column;gap:2px;}
    .stat-val{font-size:1.35rem;font-weight:800;color:#fff;}
    .stat-label{font-size:.7rem;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.06em;}
    .stat-sep{width:1px;background:rgba(255,255,255,.08);align-self:stretch;}

    /* Footer */
    .footer{position:relative;z-index:1;padding:20px 40px 28px 10%;
      font-size:.7rem;color:rgba(255,255,255,.18);border-top:1px solid rgba(255,255,255,.06);}
    /* ── Assistente LAST — botão flutuante (chat de IA) ── */
    .assistant-trigger{
      position:fixed;bottom:24px;right:24px;z-index:50;
      width:44px;height:44px;border-radius:50%;
      background:#0F49F8;border:none;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 20px rgba(15,73,248,.5);
      transition:transform .15s,box-shadow .15s;
    }
    .assistant-trigger:hover{transform:scale(1.1);box-shadow:0 6px 28px rgba(15,73,248,.7);}
    .assistant-trigger svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}

    .assistant-panel{
      position:fixed;bottom:82px;right:24px;z-index:55;
      width:360px;max-width:calc(100vw - 32px);height:480px;max-height:calc(100vh - 120px);
      background:#0f1115;border:1px solid rgba(255,255,255,.08);border-radius:16px;
      box-shadow:0 20px 60px rgba(0,0,0,.5);
      display:flex;flex-direction:column;overflow:hidden;
      opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;
      transition:opacity .18s,transform .18s;
    }
    .assistant-panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}

    .assistant-head{
      display:flex;align-items:center;gap:12px;padding:16px 16px;
      border-bottom:1px solid rgba(255,255,255,.07);
      background:linear-gradient(180deg,rgba(15,73,248,.12),transparent);
    }
    .assistant-head-icon{
      width:38px;height:38px;border-radius:12px;flex-shrink:0;
      background:#0F49F8;border:none;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 3px 10px rgba(15,73,248,.35);
    }
    .assistant-head-icon svg{width:19px;height:19px;fill:#fff;stroke:none;}
    .assistant-head-text{flex:1;min-width:0;}
    .assistant-head-text .t{font-size:.9rem;font-weight:700;color:#fff;}
    .assistant-head-text .s{font-size:.72rem;color:rgba(255,255,255,.4);}
    .assistant-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}
    .assistant-hide{background:none;border:none;color:rgba(255,255,255,.5);font-size:.75rem;cursor:pointer;padding:4px;}
    .assistant-hide:hover{color:#fff;}
    .assistant-close{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.7);font-size:.8rem;cursor:pointer;width:28px;height:28px;border-radius:8px;line-height:1;}
    .assistant-close:hover{background:rgba(255,255,255,.12);color:#fff;}

    .assistant-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;
      scrollbar-width:thin;scrollbar-color:#0F49F8 rgba(255,255,255,.04);}
    .assistant-body::-webkit-scrollbar{width:6px;}
    .assistant-body::-webkit-scrollbar-track{background:rgba(255,255,255,.03);border-radius:99px;}
    .assistant-body::-webkit-scrollbar-thumb{background:#0F49F8;border-radius:99px;}
    .assistant-body::-webkit-scrollbar-thumb:hover{background:#1a5aff;}
    .assistant-msg{max-width:88%;font-size:.82rem;line-height:1.55;padding:10px 13px;border-radius:12px;}
    .assistant-msg.bot{align-self:flex-start;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.85);border-bottom-left-radius:4px;}
    .assistant-msg.user{align-self:flex-end;background:#0F49F8;color:#fff;border-bottom-right-radius:4px;}
    .assistant-msg b{color:#fff;}

    .assistant-chips{display:flex;flex-wrap:wrap;gap:8px;padding:2px 0 4px;}
    .assistant-chip{
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
      color:rgba(255,255,255,.72);font-size:.74rem;padding:8px 13px;border-radius:12px;
      cursor:pointer;transition:background .15s,border-color .15s;
    }
    .assistant-chip:hover{background:rgba(15,73,248,.15);border-color:rgba(15,73,248,.4);color:#fff;}

    .assistant-foot{padding:12px 14px;border-top:1px solid rgba(255,255,255,.07);}
    .assistant-input-row{display:flex;gap:8px;}
    .assistant-input{
      flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);
      border-radius:10px;padding:10px 12px;color:#fff;font-size:.82rem;outline:none;
    }
    .assistant-input:focus{border-color:rgba(15,73,248,.5);}
    .assistant-send{
      width:38px;height:38px;border-radius:10px;background:#0F49F8;border:none;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;
    }
    .assistant-send:hover{background:#1a5aff;}
    .assistant-send:disabled{opacity:.5;cursor:default;}
    .assistant-send svg{width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
    .assistant-typing{align-self:flex-start;font-size:.75rem;color:rgba(255,255,255,.4);padding:2px 4px;}

    /* ── Card "Iniciar no Discord" — desenhado no hero, ao lado do texto ── */
    .connect-wrap{
      position:relative;z-index:1;flex:0 1 320px;width:100%;
      display:flex;justify-content:center;
    }
    .modal-card{
      background:#18191c;border:1px solid rgba(255,255,255,.1);
      border-radius:16px;padding:18px;width:100%;max-width:315px;
      box-shadow:0 20px 60px rgba(0,0,0,.5);
    }
    .modal-header{display:flex;align-items:center;gap:8px;margin-bottom:14px;}
    .modal-title{display:flex;align-items:center;gap:7px;font-family:'Agdasima',sans-serif;font-size:.9rem;font-weight:700;letter-spacing:.02em;color:#fff;text-transform:uppercase;}
    .modal-title img{width:21px;height:21px;}

    /* Steps */
    .modal-step{display:flex;flex-direction:column;gap:8px;}
    .step-label{display:flex;align-items:center;gap:7px;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.45);}
    .step-badge{width:17px;height:17px;border-radius:50%;background:#0F49F8;color:#fff;font-size:.58rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .step-badge.done{background:#2e7d32;}
    .step-text{font-size:.75rem;color:rgba(255,255,255,.4);line-height:1.5;}

    /* Hint de aguardar */
    .modal-hint-row{
      display:flex;align-items:center;gap:7px;
      padding:8px 11px;
      background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.2);
      border-radius:8px;font-size:.75rem;color:rgba(255,255,255,.4);
    }
    .modal-hint-row svg{width:13px;height:13px;fill:none;stroke:#5865f2;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;}

    /* Card usuário compacto */
    .user-card-sm{display:flex;align-items:center;gap:10px;padding:9px 11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:9px;}
    .user-card-av-sm{width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;}
    .user-card-name-sm{font-size:.79rem;font-weight:700;color:#fff;}
    .user-card-tag-sm{font-size:.65rem;color:rgba(255,255,255,.3);}
    .badge-ok{margin-left:auto;background:#2e7d32;color:#fff;border-radius:50%;width:17px;height:17px;font-size:.56rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .logout-btn{background:none;border:1px solid rgba(255,255,255,.12);border-radius:6px;
      color:rgba(255,255,255,.4);width:20px;height:20px;font-size:.6rem;line-height:1;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
    .logout-btn:hover{background:#0F49F8;border-color:#0F49F8;color:#fff;}

    /* Canal de voz */
    .voice-row{display:flex;align-items:center;gap:9px;padding:9px 11px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:9px;}
    .voice-icon svg{width:14px;height:14px;fill:none;stroke:#3ba55d;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
    .voice-name{font-size:.78rem;font-weight:600;color:#f2f3f5;}
    .voice-guild{font-size:.64rem;color:rgba(255,255,255,.28);}
    .voice-guild.on{color:#3ba55d;}
    .voice-info{flex:1;min-width:0;}
    .voice-spinner{width:12px;height:12px;border:2px solid rgba(255,255,255,.15);border-top-color:#3ba55d;border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;}
    .voice-spinner.hidden{display:none;}

    /* Erro */
    .modal-error{font-size:.72rem;color:#8ab4ff;background:rgba(15,73,248,.08);border:1px solid rgba(15,73,248,.2);border-radius:7px;padding:7px 10px;line-height:1.4;}

    /* Botão conectar */
    .modal-btn-connect{
      display:flex;align-items:center;justify-content:center;gap:8px;
      padding:10px 0;background:#0F49F8;border:none;border-radius:9px;
      color:#fff;font-size:.81rem;font-weight:700;cursor:pointer;width:100%;
      box-shadow:0 3px 14px rgba(15,73,248,.3);
      transition:background .15s,transform .15s;
      margin-top:3px;
    }
    .modal-btn-connect:hover:not(:disabled){background:#1a5aff;transform:translateY(-1px);}
    .modal-btn-connect:disabled{opacity:.45;cursor:not-allowed;}
    .modal-btn-connect svg{width:14px;height:14px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}
    .modal-btn-connect.connected{background:#2e7d32;cursor:default;}
    .modal-btn-connect.connected:hover{transform:none;}
  </style>
</head>
<body>
  <!-- Splash de entrada -->
  <div class="splash" id="splash">
    <img class="splash-logo" src="/assets/landing/logo.png" alt="LAST">
    <div class="splash-bar"></div>
  </div>

  <div class="bg"></div>
  <div class="bg-fade"></div>

  <!-- Topbar -->
  <nav class="topbar">
    <div class="topbar-left">
      <img class="topbar-logo" src="/assets/landing/logo.png" alt="Last PVP">
      <span class="topbar-name">Last PVP</span>
      <div class="topbar-sep"></div>
      <span class="topbar-sub">transmissões</span>
    </div>
    <button class="btn-discord" id="btnLogin">
      <svg viewBox="0 0 127.14 96.36" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
      </svg>
      Conectar Discord
    </button>
    <div class="user-pill" id="userPill">
      <img id="userAvatar" src="" alt="">
      <span id="userName"></span>
    </div>
  </nav>

  <!-- Hero -->
  <section class="hero">
    <div class="hero-content">
      <div class="eyebrow anim-1"><span class="eyebrow-dot"></span>Last PVP<span class="eyebrow-sep">ponto a ponto</span></div>
      <h1 class="anim-2">Sua tela, ao vivo,<br>direto para o Discord.</h1>
      <p class="desc anim-3">Entre na sua atividade do Discord e coloque para transmitir pelo navegador. Assim, seus amigos vão conseguir assistir à transmissão diretamente pelo Discord.</p>

      <div class="features anim-4">
        <div class="feature">
          <div class="feature-icon"><img src="/assets/landing/icon-bolt.svg" alt=""></div>
          Sala instantanea
        </div>
        <div class="feature">
          <div class="feature-icon"><img src="/assets/landing/icon-shield.svg" alt=""></div>
          O video vai de um navegador ao outro, sem passar pelo servidor
        </div>
        <div class="feature">
          <div class="feature-icon"><img src="/assets/landing/icon-users.svg" alt=""></div>
          Varias pessoas podem transmitir ao mesmo tempo
        </div>
      </div>
    </div>

    <!-- ═══ INICIAR NO DISCORD — card desenhado ao lado do texto ═══ -->
    <div class="connect-wrap">
      <div class="modal-card" id="modalCard">

        <!-- Cabeçalho -->
        <div class="modal-header">
          <div class="modal-title">
            <img src="/assets/landing/icon-discord.svg" alt="">
            Iniciar no Discord
          </div>
        </div>

        <!-- Passo 1: aviso para usar o botão da topbar -->
        <div class="modal-step" id="step1">
          <div class="step-label"><span class="step-badge">1</span> Conecte sua conta</div>
          <p class="step-text">Use o botão <strong style="color:#5865f2">Conectar Discord</strong> no topo da página para autenticar. Sua foto e nome aparecem aqui automaticamente.</p>
          <div class="modal-hint-row">
            <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Aguardando autenticação…
          </div>
        </div>

        <!-- Passo 2: canal de voz + botão conectar (aparece após login) -->
        <div class="modal-step" id="step2" hidden>

          <!-- Card do usuário compacto -->
          <div class="user-card-sm">
            <img class="user-card-av-sm" id="modalUserAv" src="" alt="">
            <div>
              <div class="user-card-name-sm" id="modalUserName">…</div>
              <div class="user-card-tag-sm">Discord conectado</div>
            </div>
            <span class="badge-ok">✓</span>
            <button class="logout-btn" id="btnLogout" title="Sair da conta">✕</button>
          </div>

          <!-- Canal de voz com status de refresh -->
          <div class="step-label" style="margin-top:4px"><span class="step-badge">2</span> Canal de voz</div>
          <div class="voice-row" id="voiceChannelRow">
            <div class="voice-icon">
              <svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </div>
            <div class="voice-info">
              <div class="voice-name" id="voiceChannelName">Buscando canal…</div>
              <div class="voice-guild" id="voiceChannelStatus"></div>
            </div>
            <div class="voice-spinner" id="voiceSpinner"></div>
          </div>

          <div class="modal-error" id="modalError" hidden></div>

          <button class="modal-btn-connect" id="btnConnect" disabled>
            <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
            Conectar bot
          </button>
        </div>

      </div>
    </div>
  </section>

  <footer class="footer">Last PVP · Transmissões ao vivo · lastpvp.online</footer>

  <!-- ═══════════════════ ASSISTENTE LAST ═══════════════════ -->
  <button class="assistant-trigger" id="assistantTrigger" title="Assistente LAST">
    <svg viewBox="0 0 24 24"><path d="M7.5 5h9A3.5 3.5 0 0 1 20 8.5v3a3.5 3.5 0 0 1-3.5 3.5H12l-3.5 3.2V15H7.5A3.5 3.5 0 0 1 4 11.5v-3A3.5 3.5 0 0 1 7.5 5z"/></svg>
  </button>

  <div class="assistant-panel" id="assistantPanel">
    <div class="assistant-head">
      <div class="assistant-head-icon">
        <svg viewBox="0 0 24 24"><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2z"/><path d="M19 14l.8 2.6 2.2.8-2.2.8L19 21l-.8-2.8-2.2-.8 2.2-.8L19 14z"/></svg>
      </div>
      <div class="assistant-head-text">
        <div class="t">Assistente LAST</div>
        <div class="s">Dúvidas da plataforma · todas as páginas</div>
      </div>
      <div class="assistant-head-actions">
        <button class="assistant-hide" id="assistantHide">Esconder</button>
        <button class="assistant-close" id="assistantClose">✕</button>
      </div>
    </div>

    <div class="assistant-body" id="assistantBody">
      <div class="assistant-msg bot">Olá! Sou o <b>Assistente LAST</b> — posso te ajudar com dúvidas sobre a plataforma: conectar sua conta do Discord, criar ou entrar em salas, transmitir tela ou câmera, qualidade/fps e problemas comuns. Pergunte à vontade!</div>
      <div class="assistant-chips" id="assistantChips">
        <button class="assistant-chip">Como conecto minha conta?</button>
        <button class="assistant-chip">Como crio uma sala?</button>
        <button class="assistant-chip">Como transmito minha tela?</button>
      </div>
    </div>

    <div class="assistant-foot">
      <div class="assistant-input-row">
        <input class="assistant-input" id="assistantInput" placeholder="Digite sua dúvida…" maxlength="500" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-form-type="other" name="next-assistant-msg-9f3a">
        <button class="assistant-send" id="assistantSend">
          <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  </div>

  <script>
    const CLIENT_ID = '1540951591685853305';
    const REDIRECT  = location.origin + location.pathname;

    // ── Remove splash ──
    setTimeout(() => {
      const s = document.getElementById('splash');
      if (s) { s.classList.add('out'); setTimeout(() => s.remove(), 600); }
    }, 900);

    // ── Estado global ──
    let discordToken = null;
    let discordUser  = null;
    let guildId      = null;
    let channelId    = null;

    // ── Topbar: botão login principal ──
    const btnLogin = document.getElementById('btnLogin');
    const userPill = document.getElementById('userPill');
    const userAv   = document.getElementById('userAvatar');
    const userNm   = document.getElementById('userName');

    function applyUser(u, tok) {
      discordToken = tok;
      discordUser  = u;
      if (!u || !u.id) return; // token inválido, ignora
      // Salva a sessão — mantém a conta conectada ao recarregar o site
      try {
        localStorage.setItem('nextToken', tok);
        localStorage.setItem('nextUser', JSON.stringify({
          id: u.id, username: u.username, global_name: u.global_name,
          avatar: u.avatar, discriminator: u.discriminator,
        }));
      } catch {}
      const av = u.avatar
        ? 'https://cdn.discordapp.com/avatars/'+u.id+'/'+u.avatar+'.png?size=128'
        : 'https://cdn.discordapp.com/embed/avatars/'+((Number(u.discriminator||0))%5)+'.png';
      // Topbar
      userAv.src = av;
      userNm.textContent = u.global_name || u.username;
      btnLogin.style.display = 'none';
      userPill.classList.add('visible');
      // Card — preenche dados, some o "Aguardando autenticação…" e vai pro passo 2
      document.getElementById('modalUserAv').src = av;
      document.getElementById('modalUserName').textContent = u.global_name || u.username;
      document.getElementById('step1').hidden = true;
      document.getElementById('step2').hidden = false;
      startVoiceRefresh(u);
    }

    // ── Sair da conta (X no card) ──
    function deslogar() {
      try { localStorage.removeItem('nextToken'); localStorage.removeItem('nextUser'); } catch {}
      discordToken = null;
      discordUser  = null;
      guildId      = null;
      channelId    = null;
      lastGuilds   = [];
      if (voiceRefreshTimer) { clearInterval(voiceRefreshTimer); voiceRefreshTimer = null; }
      // Topbar volta pro botão de login
      btnLogin.style.display = '';
      userPill.classList.remove('visible');
      // Card volta pro passo 1
      document.getElementById('step2').hidden = true;
      document.getElementById('step1').hidden = false;
      // Reseta o estado do canal de voz e do botão conectar
      const vcName  = document.getElementById('voiceChannelName');
      const vcGuild = document.getElementById('voiceChannelStatus');
      vcName.textContent = 'Buscando canal…';
      vcGuild.textContent = '';
      vcGuild.classList.remove('on');
      const spinner = document.getElementById('voiceSpinner');
      if (spinner) spinner.classList.remove('hidden');
      document.getElementById('modalError').hidden = true;
      const btnConn = document.getElementById('btnConnect');
      btnConn.classList.remove('connected');
      btnConn.disabled = true;
      btnConn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg> Conectar bot';
    }

    // Verifica retorno do OAuth no hash
    const hash = new URLSearchParams(location.hash.slice(1));
    const tok  = hash.get('access_token');
    if (tok) {
      history.replaceState(null,'',location.pathname+location.search);
      fetch('https://discord.com/api/users/@me',{headers:{Authorization:'Bearer '+tok}})
        .then(r=>r.json()).then(u => { if (u && u.id) applyUser(u, tok); }).catch(()=>{});
    } else {
      // Sem OAuth no hash: restaura a sessão salva (conta continua conectada)
      const savedTok = localStorage.getItem('nextToken');
      if (savedTok) {
        fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + savedTok } })
          .then(r => r.ok ? r.json() : Promise.reject(new Error('expirado')))
          .then(u => { if (u && u.id) applyUser(u, savedTok); else deslogar(); })
          .catch(() => deslogar());
      }
    }

    function doOAuth() {
      location.href = 'https://discord.com/oauth2/authorize'
        + '?client_id=' + CLIENT_ID
        + '&redirect_uri=' + encodeURIComponent(REDIRECT)
        + '&response_type=token'
        + '&scope=identify%20guilds';
    }

    btnLogin.addEventListener('click', doOAuth);
    document.getElementById('btnLogout').addEventListener('click', deslogar);

    // ── Refresh canal de voz a cada 5s ──
    let voiceRefreshTimer = null;
    let lastGuilds = [];

    async function fetchVoiceChannel(u, silent = false) {
      const vcName    = document.getElementById('voiceChannelName');
      const vcGuild   = document.getElementById('voiceChannelStatus');
      const btnConn   = document.getElementById('btnConnect');
      const errEl     = document.getElementById('modalError');
      const spinner   = document.getElementById('voiceSpinner');

      if (!silent) { vcName.textContent = 'Buscando…'; vcGuild.textContent = ''; vcGuild.classList.remove('on'); }
      if (spinner) spinner.classList.remove('hidden');
      errEl.hidden = true;

      // Busca guilds (só na primeira vez, depois reutiliza)
      if (!silent || !lastGuilds.length) {
        try {
          const r = await fetch('https://discord.com/api/users/@me/guilds', {headers:{Authorization:'Bearer '+discordToken}});
          lastGuilds = await r.json();
        } catch { lastGuilds = []; }
      }

      for (const g of (lastGuilds || [])) {
        try {
          const r = await fetch('/api/voice-channel', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ access_token: discordToken, guild_id: g.id, user_id: u.id }),
          });
          if (!r.ok) continue;
          const d = await r.json();
          if (d.channel) {
            vcName.textContent  = d.channel.name;
            vcGuild.textContent = g.name;
            vcGuild.classList.add('on');
            guildId   = g.id;
            channelId = d.channel.id;
            btnConn.disabled = false;
            errEl.hidden = true;
            if (spinner) spinner.classList.add('hidden');
            return true;
          }
        } catch {}
      }

      // Ainda não entrou em nenhum canal — segue verificando a cada 5s.
      // O botão só é liberado quando a pessoa realmente conectar na call.
      vcName.textContent  = 'Você não está em uma call';
      vcGuild.textContent = 'Verificando novamente em 5 segundos…';
      vcGuild.classList.remove('on');
      errEl.hidden = true;
      btnConn.disabled = true;
      if (spinner) spinner.classList.remove('hidden');
      return false;
    }

    function startVoiceRefresh(u) {
      // Limpa timer anterior
      if (voiceRefreshTimer) clearInterval(voiceRefreshTimer);
      fetchVoiceChannel(u, false);
      voiceRefreshTimer = setInterval(async () => {
        // Só faz refresh se o botão ainda estiver desabilitado (não conectado)
        const btnConn = document.getElementById('btnConnect');
        if (btnConn && !btnConn.classList.contains('connected')) {
          await fetchVoiceChannel(u, true);
        } else {
          clearInterval(voiceRefreshTimer);
        }
      }, 5000);
    }

    // ── Abre o convite no app do Discord (sem pop-up) ──
    function abrirConviteDiscord(inviteUrl) {
      const code = String(inviteUrl).split('/').pop();

      // Tenta o aplicativo direto pelo deep link (Windows/macOS/Linux/celular).
      // Roda no mesmo instante do clique, então o navegador não bloqueia.
      try { window.location.href = 'discord://-/invite/' + code; } catch {}

      // Link manual visível caso o app não abra — clique em link real nunca
      // é bloqueado como pop-up.
      const errEl = document.getElementById('modalError');
      errEl.hidden = false;
      errEl.innerHTML = 'O Discord não abriu? Use o convite: '
        + '<a href="' + inviteUrl + '" target="_blank" rel="noopener" style="color:#7fe39a;text-decoration:underline">'
        + 'abrir discord.gg/' + code + '</a>';
    }

    // ── Botão conectar bot ──
    document.getElementById('btnConnect').addEventListener('click', async () => {
      const btnConn = document.getElementById('btnConnect');
      const errEl   = document.getElementById('modalError');
      btnConn.disabled = true;
      btnConn.innerHTML = 'Conectando…';
      errEl.hidden = true;

      try {
        const r = await fetch('/api/start-activity', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            access_token: discordToken,
            guild_id: guildId,
            channel_id: channelId,
            user_id: discordUser.id,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Erro ao conectar');
        // Para o refresh automático
        if (voiceRefreshTimer) { clearInterval(voiceRefreshTimer); voiceRefreshTimer = null; }
        // Sucesso — só agora vira "Conectado"
        btnConn.classList.add('connected');
        btnConn.disabled = true;
        btnConn.innerHTML = '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:#fff;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg> Conectado';
        // Abre o convite: tenta o app do Discord direto, com fallback pro navegador
        if (d.invite_url) abrirConviteDiscord(d.invite_url);
      } catch(e) {
        errEl.textContent = e.message;
        errEl.hidden = false;
        btnConn.disabled = false;
        btnConn.innerHTML = '<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg> Tentar novamente';
      }
    });

    // ── Assistente LAST ──
    (function(){
      var trigger = document.getElementById('assistantTrigger');
      var panel = document.getElementById('assistantPanel');
      var closeBtn = document.getElementById('assistantClose');
      var body = document.getElementById('assistantBody');
      var chips = document.getElementById('assistantChips');
      var input = document.getElementById('assistantInput');
      var sendBtn = document.getElementById('assistantSend');
      var sending = false;

      function toggle(open){
        panel.classList.toggle('open', open);
        if (open) setTimeout(function(){ input.focus(); }, 150);
      }
      trigger.addEventListener('click', function(){ toggle(!panel.classList.contains('open')); });
      closeBtn.addEventListener('click', function(){ toggle(false); });
      var hideBtn = document.getElementById('assistantHide');
      if (hideBtn) hideBtn.addEventListener('click', function(){ toggle(false); });

      function addMsg(text, who){
        var div = document.createElement('div');
        div.className = 'assistant-msg ' + who;
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
        return div;
      }

      function send(text){
        text = (text || input.value).trim();
        if (!text || sending) return;
        sending = true;
        input.value = '';
        if (chips) { chips.remove(); chips = null; }
        addMsg(text, 'user');
        sendBtn.disabled = true;
        var typing = document.createElement('div');
        typing.className = 'assistant-typing';
        typing.textContent = 'Digitando…';
        body.appendChild(typing);
        body.scrollTop = body.scrollHeight;

        fetch('/api/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        })
          .then(function(r){ return r.json(); })
          .then(function(d){
            typing.remove();
            addMsg(d.reply || d.error || 'Não consegui responder agora.', 'bot');
          })
          .catch(function(){
            typing.remove();
            addMsg('Erro ao falar com o assistente. Tente novamente.', 'bot');
          })
          .finally(function(){
            sending = false;
            sendBtn.disabled = false;
          });
      }

      sendBtn.addEventListener('click', function(){ send(); });
      input.addEventListener('keydown', function(e){
        if (e.key === 'Enter') send();
      });
      if (chips) {
        chips.querySelectorAll('.assistant-chip').forEach(function(chip){
          chip.addEventListener('click', function(){ send(chip.textContent); });
        });
      }
    })();
  </script>
</body>
</html>`;
// SPA fallback — landing quando não há token, index.html quando tem
app.get('*', (req, res) => {
  const hasToken = req.query.t || req.query.frame_id;
  if (!hasToken) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(LANDING_HTML);
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// -----------------------------------------------------------------
// Relay WebSocket: /ws?t=<token>[&fonte=tela|camera][&modo=controle]
//
// Pap�is:
//  - fonte=...     ? transmissor (recebe um slot, repacota nada: s� repassa)
//  - modo=controle ? canal de controle da aba de captura
//  - resto         ? visualizador
//
// Formato bin�rio (v�deo e �udio), definido pelo broadcaster.js:
//   [1B slot][1B tipo][8B timestamp f64][8B rel�gio envio f64][payload]
// -----------------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rodando na porta ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`Sem permiss�o para abrir a porta ${PORT}. No Shard Cloud use a porta 80 (padr�o). Testando local? Defina PORT=3000 no .env.`);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} j� est� em uso por outro processo.`);
  } else {
    console.error('Erro ao iniciar o servidor:', err);
  }
  process.exit(1);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  // Remove o prefixo /.proxy do IN�CIO do path (Discord proxy encaminha como /.proxy/ws,
  // n�o /ws/.proxy). O regex anterior removia do final e nunca casava dentro do Discord.
  if (url.pathname.replace(/^\/.proxy/, '').replace(/\/+$/, '') !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, url.searchParams);
  });
});

wss.on('connection', (ws, request, params) => {
  ws.binaryType = 'nodebuffer';
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  const payload = verifyToken(params.get('t'));
  if (!payload || !payload.room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Token inv�lido.' }));
    ws.close(4001, 'token invalido');
    return;
  }

  const room = getRoom(payload.room);
  const fonte = params.get('fonte');
  const modo = params.get('modo');

  if (modo === 'controle') attachControl(ws, room, payload);
  else if (fonte) attachBroadcaster(ws, room, payload, fonte);
  else attachViewer(ws, room, payload);
});

// ------------------------------------------------------------ transmissor

function attachBroadcaster(ws, room, payload, fonte) {
  if (payload.role !== 'broadcaster') {
    ws.send(JSON.stringify({ type: 'error', message: 'Token sem permiss�o de transmiss�o.' }));
    ws.close(4003, 'sem permissao');
    return;
  }

  // Uma transmiss�o por usu�rio/fonte: segunda conex�o � recusada.
  for (const b of room.broadcasters.values()) {
    if (b.userId === payload.uid && b.fonte === fonte) {
      ws.send(JSON.stringify({ type: 'error', message: 'Voc� j� est� transmitindo desta fonte nesta sala.' }));
      ws.close(4002, 'ja transmitindo');
      return;
    }
  }

  const slot = room.nextSlot++;
  const b = {
    ws,
    slot,
    userId: payload.uid,
    name: payload.name,
    av: payload.av,
    banner: payload.banner || '',
    accentColor: payload.accentColor != null ? payload.accentColor : null,
    fonte,
    active: false,
    config: null,
    audioConfig: null,
  };
  room.broadcasters.set(slot, b);

  safeSend(ws, { type: 'slot', slot });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Repassa o buffer intacto para todos os visualizadores.
      if (!b.active) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      for (const v of room.viewers) {
        try {
          if (v.ws.readyState === WS_OPEN) v.ws.send(buf, { binary: true });
        } catch {}
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'start':
        b.active = true;
        logar(`**${b.name}** come�ou a transmitir **${b.fonte}** na sala \`${room.id}\` (${horario()})`);
        bot.logTransmissaoIniciada({ name: b.name, userId: b.userId, av: b.av, fonte: b.fonte, roomId: room.id });
        broadcastStreamStart(room, b);
        sendStateToAll(room);
        break;
      case 'config':
        b.config = msg.config;
        forwardConfig(room, b, 'config');
        sendStateToAll(room);
        break;
      case 'audio-config':
        b.audioConfig = msg.config;
        forwardConfig(room, b, 'audio-config');
        sendStateToAll(room);
        break;
      case 'stop':
        if (b.active) {
          b.active = false;
          logar(`**${b.name}** parou de transmitir (${horario()})`);
          bot.logTransmissaoEncerrada({ name: b.name, userId: b.userId, av: b.av, fonte: b.fonte, roomId: room.id });
          broadcastStreamStop(room, b.slot);
          sendStateToAll(room);
        }
        break;
      case 'native-audio-start':
        // Captura nativa do Firefox depende de um agente na m�quina do
        // usu�rio; este servidor n�o oferece isso.
        safeSend(ws, {
          type: 'native-audio-error',
          message: '�udio nativo do Firefox n�o est� dispon�vel neste servidor.',
        });
        break;
      case 'native-audio-stop':
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    room.broadcasters.delete(b.slot);
    if (b.active) {
      b.active = false;
      bot.logTransmissaoEncerrada({ name: b.name, userId: b.userId, av: b.av, fonte: b.fonte, roomId: room.id });
      broadcastStreamStop(room, b.slot);
    }
    sendStateToAll(room);
    sendViewersCount(room);
    maybeCloseRoom(room);
  });
}

// --------------------------------------------------------------- controle

function attachControl(ws, room) {
  room.controls.add(ws);

  ws.on('message', (data) => {
    // Controle s� escuta; nada chega dele na refer�ncia.
  });

  ws.on('close', () => {
    room.controls.delete(ws);
    maybeCloseRoom(room);
  });
}

// ------------------------------------------------------------ visualizador

function attachViewer(ws, room, payload) {
  const v = { ws, userId: payload.uid, name: payload.name, av: payload.av, banner: payload.banner || '', accentColor: payload.accentColor != null ? payload.accentColor : null };
  room.viewers.add(v);
  logar(`**${v.name}** entrou na sala \`${room.id}\` (${room.viewers.size} assistindo)`);

  // Manda o estado atual para o novo viewer (inclui ele mesmo na lista)
  const streams = activeStreams(room);
  safeSend(ws, { type: 'state', participants: participants(room), abas: [], room: null, streams });
  for (const s of streams) {
    if (s.config)      safeSend(ws, { type: 'config',       slot: s.slot, config: s.config });
    if (s.audioConfig) safeSend(ws, { type: 'audio-config', slot: s.slot, config: s.audioConfig });
  }

  // Avisa TODOS os outros (viewers + broadcasters) que uma nova pessoa entrou
  const stateAtualizado = { type: 'state', participants: participants(room), abas: [], room: null, streams };
  for (const outro of room.viewers) {
    if (outro !== v) safeSend(outro.ws, stateAtualizado);
  }
  for (const b of room.broadcasters.values()) safeSend(b.ws, stateAtualizado);

  sendViewersCount(room);

  // Pede keyframe aos transmissores ativos: quem acabou de entrar precisa
  // de um ponto de partida.
  for (const b of room.broadcasters.values()) {
    if (b.active) safeSend(b.ws, { type: 'need-keyframe' });
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'rename' && typeof msg.name === 'string') {
      v.name = msg.name.slice(0, 32);
      sendStateToAll(room);
    } else if (msg.type === 'need-keyframe') {
      // Visualizador recriou o decoder (ex.: resolu��o mudou no meio do ar):
      // pede um ponto de partida novo aos transmissores ativos.
      for (const b of room.broadcasters.values()) {
        if (b.active) safeSend(b.ws, { type: 'need-keyframe' });
      }
    } else if (msg.type === 'start-broadcast') {
      // A atividade pediu uma fonte pela interface: repassa �s abas de captura.
      for (const c of room.controls) {
        safeSend(c, { type: 'start-request', fonte: msg.fonte, opcoes: msg.opcoes });
      }
    } else if (msg.type === 'config-broadcast') {
      for (const c of room.controls) {
        safeSend(c, { type: 'config-request', opcoes: msg.opcoes });
      }
    }
  });

  ws.on('close', () => {
    room.viewers.delete(v);
    logar(`**${v.name}** saiu da sala (${room.viewers.size} restantes)`);
    sendViewersCount(room);
    sendStateToAll(room);
    maybeCloseRoom(room);
  });
}

// Limpa sockets mortos (rede caiu sem close) a cada 30s.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);

