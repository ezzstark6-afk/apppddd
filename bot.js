/**
 * Bot do Discord — status e logs com Components v2
 * Canal de logs: 1541125991689359520
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = '1542347196781830174';

if (!BOT_TOKEN) {
  console.warn('[bot] BOT_TOKEN não definido — bot não iniciado.');
  module.exports = { logTransmissaoIniciada: () => {}, logTransmissaoEncerrada: () => {}, logSalaCriada: () => {}, logSalaFechada: () => {} };
  return;
}

const { Client, GatewayIntentBits, ActivityType, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', () => {
  console.log(`[bot] Logado como ${client.user.tag}`);

  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: 'Analisando telas',
        type: ActivityType.Custom,
        state: 'Analisando telas',
      },
    ],
  });
});

client.login(BOT_TOKEN).catch((err) => {
  console.error('[bot] Falha ao logar:', err.message);
});

// -------------------------------------------------------------  helpers

function horarioBR() {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

async function enviarLog(container) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('[bot] Erro ao enviar log:', err.message);
  }
}

// -------------------------------------------------------------  eventos

/**
 * Transmissão iniciada
 */
async function logTransmissaoIniciada(info) {
  const fonteLabel = info.fonte === 'camera'
    ? '<:controle:1537636925173923861> Câmera'
    : '<:controle:1537636925173923861> Tela';

  const container = new ContainerBuilder()
    .setAccentColor(0x23a55a)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### <:dowload:1537636547912802355> Transmissão iniciada\n**${info.name}** começou a transmitir ${fonteLabel}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <:pasta:1537636518519251005> Sala: \`${info.roomId}\`  •  <:baguideareiaquedaparaverotempo:1537636319445000282> ${horarioBR()}`
      )
    );

  await enviarLog(container);
}

/**
 * Transmissão encerrada
 */
async function logTransmissaoEncerrada(info) {
  const fonteLabel = info.fonte === 'camera'
    ? '<:controle:1537636925173923861> Câmera'
    : '<:controle:1537636925173923861> Tela';

  const container = new ContainerBuilder()
    .setAccentColor(0x0F49F8)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### <:lixeira:1537635876916564010> Transmissão encerrada\n**${info.name}** parou de transmitir ${fonteLabel}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <:pasta:1537636518519251005> Sala: \`${info.roomId}\`  •  <:baguideareiaquedaparaverotempo:1537636319445000282> ${horarioBR()}`
      )
    );

  await enviarLog(container);
}

/**
 * Sala criada
 */
async function logSalaCriada(info) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### <:pasta:1537636518519251005> Sala criada\nUma nova sala foi aberta`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <:pasta:1537636518519251005> Sala: \`${info.roomId}\`  •  <:baguideareiaquedaparaverotempo:1537636319445000282> ${horarioBR()}`
      )
    );

  await enviarLog(container);
}

/**
 * Sala fechada
 */
async function logSalaFechada(info) {
  const container = new ContainerBuilder()
    .setAccentColor(0xf0b232)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### <:lixeira:1537635876916564010> Sala fechada\nA sala ficou vazia e foi encerrada`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <:pasta:1537636518519251005> Sala: \`${info.roomId}\`  •  <:baguideareiaquedaparaverotempo:1537636319445000282> ${horarioBR()}`
      )
    );

  await enviarLog(container);
}

module.exports = {
  logTransmissaoIniciada,
  logTransmissaoEncerrada,
  logSalaCriada,
  logSalaFechada,
  /**
   * Retorna o canal de voz onde o usuário está.
   * @param {string} guildId
   * @param {string} userId
   * @returns {Promise<{id:string, name:string}|null>}
   */
  async getVoiceChannel(guildId, userId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.members.fetch(userId);
      const member = guild.members.cache.get(userId);
      if (!member?.voice?.channel) return null;
      return { id: member.voice.channel.id, name: member.voice.channel.name };
    } catch {
      return null;
    }
  },
};
