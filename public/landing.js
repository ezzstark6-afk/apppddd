const CLIENT_ID = '1540951591685853305';
const REDIRECT_URI = `${location.origin}${location.pathname}`;
const SCOPES = 'identify guilds';
const STORAGE_KEY = 'nextcup_discord';

const $ = (id) => document.getElementById(id);

let user = null;
let channels = [];
let selectedChannel = null;
let accessToken = null;

function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4000);
}

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || 'Erro na requisição');
  return data;
}

async function fetchDiscordUser(token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Sessão expirada');
  return res.json();
}

function saveSession(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  user = null;
  accessToken = null;
  channels = [];
  selectedChannel = null;
  renderAuthState();
  renderChannels();
  updateConnectBot();
}

function avatarUrl(u) {
  if (u.avatar) {
    return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`;
  }
  const idx = Number(u.discriminator || 0) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function connectDiscord() {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  location.href = url.toString();
}

function renderAuthState() {
  const waiting = $('authWaiting');
  const connected = $('userConnected');

  if (user) {
    waiting.hidden = true;
    connected.hidden = false;
    $('userName').textContent = user.global_name || user.username;
    $('userAvatar').src = avatarUrl(user);
  } else {
    waiting.hidden = false;
    connected.hidden = true;
  }
}

function renderChannels() {
  const picker = $('channelPicker');
  const list = $('channelList');
  const nameEl = $('channelName');

  list.innerHTML = '';

  if (!user) {
    picker.disabled = true;
    nameEl.textContent = 'Conecte o Discord primeiro';
    picker.classList.remove('selected');
    list.classList.remove('open');
    return;
  }

  if (!channels.length) {
    picker.disabled = true;
    nameEl.textContent = 'Buscando canal…';
    picker.classList.remove('selected');
    return;
  }

  picker.disabled = false;

  channels.forEach((ch) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'channel-option' + (selectedChannel?.id === ch.id ? ' active' : '');
    opt.textContent = ch.name;
    opt.addEventListener('click', () => selectChannel(ch));
    list.appendChild(opt);
  });

  if (selectedChannel) {
    nameEl.textContent = selectedChannel.name;
    picker.classList.add('selected');
  } else {
    nameEl.textContent = 'Selecione um canal';
    picker.classList.remove('selected');
  }
}

function selectChannel(ch) {
  selectedChannel = ch;
  $('channelList').classList.remove('open');
  renderChannels();
  updateConnectBot();
}

function updateConnectBot() {
  $('btnConnectBot').disabled = !(user && selectedChannel);
}

async function fetchChannels() {
  if (!accessToken) return;

  $('channelName').textContent = 'Buscando canal…';
  $('channelPicker').disabled = true;

  try {
    const data = await api('/api/channels', null, accessToken);
    channels = data.channels || data || [];
    renderChannels();
    updateConnectBot();
  } catch (e) {
    console.error(e);
    channels = [];
    $('channelName').textContent = 'Nenhum canal encontrado';
    toast('Não foi possível carregar os canais de voz.', true);
  }
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;

  history.replaceState({}, '', location.pathname);

  try {
    const { access_token, user: u } = await api('/api/token', { code });
    accessToken = access_token;
    user = u || await fetchDiscordUser(access_token);
    saveSession({ access_token, user });
    renderAuthState();
    await fetchChannels();
    toast('Discord conectado!');
    return true;
  } catch (e) {
    console.error(e);
    toast(e.message || 'Erro ao autenticar.', true);
    return false;
  }
}

async function restoreSession() {
  const saved = loadSession();
  if (!saved?.access_token) return;

  accessToken = saved.access_token;
  user = saved.user;

  try {
    user = await fetchDiscordUser(accessToken);
    saveSession({ access_token: accessToken, user });
  } catch {
    clearSession();
    return;
  }

  renderAuthState();
  await fetchChannels();
}

async function connectBot() {
  if (!selectedChannel || !accessToken) return;

  const btn = $('btnConnectBot');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Conectando…';

  try {
    await api('/api/bot/connect', { channel_id: selectedChannel.id }, accessToken);
    toast('Bot conectado ao canal!');
    btn.querySelector('span').textContent = 'Conectado';
  } catch (e) {
    console.error(e);
    toast(e.message || 'Erro ao conectar o bot.', true);
    btn.querySelector('span').textContent = 'Conectar bot';
    btn.disabled = false;
  }
}

function bindEvents() {
  $('btnDiscordNav').addEventListener('click', connectDiscord);
  $('btnDisconnect').addEventListener('click', clearSession);

  $('channelPicker').addEventListener('click', () => {
    if (!channels.length) return;
    $('channelList').classList.toggle('open');
  });

  $('btnConnectBot').addEventListener('click', connectBot);

  $('fab').addEventListener('click', () => {
    window.open('https://discord.gg/', '_blank', 'noopener');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.channel-picker') && !e.target.closest('.channel-list')) {
      $('channelList').classList.remove('open');
    }
  });
}

(async function init() {
  bindEvents();

  const fromOAuth = await handleOAuthCallback();
  if (!fromOAuth) await restoreSession();

  renderAuthState();
  renderChannels();
  updateConnectBot();
})();
