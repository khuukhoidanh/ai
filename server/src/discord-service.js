'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[a-f0-9-]{36}$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function assertUuid(value, message) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(message);
  }
}

function assertSnowflake(value, message) {
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) {
    throw new ValidationError(message);
  }
}

function assertUsername(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
    throw new ValidationError('Tên người dùng không hợp lệ.');
  }
  return value.trim();
}

function createDiscordService({ client, guildId, botId: initialBotId = null }) {
  let cachedBotId = initialBotId || null;

  async function resolveBotId() {
    if (cachedBotId) return cachedBotId;
    const bot = await client.request('GET', '/users/@me');
    if (!bot || !SNOWFLAKE_RE.test(String(bot.id || ''))) {
      throw new Error('Không xác định được ID bot Discord.');
    }
    cachedBotId = String(bot.id);
    return cachedBotId;
  }

  async function setup() {
    const bot = await client.request('GET', '/users/@me');
    const guild = await client.request('GET', '/guilds/' + guildId);
    if (bot && SNOWFLAKE_RE.test(String(bot.id || ''))) {
      cachedBotId = String(bot.id);
    }
    return {
      ok: true,
      botId: cachedBotId,
      bot: bot && bot.username ? String(bot.username) : '',
      server: guild && guild.name ? String(guild.name) : ''
    };
  }

  async function ensureChannel(payload) {
    const input = payload || {};
    assertUuid(input.ownerId, 'Mã chủ sở hữu không hợp lệ.');
    assertUuid(input.chatId, 'Mã cuộc chat không hợp lệ.');
    const username = assertUsername(input.username);
    const botId = await resolveBotId();

    const channels = await client.request('GET', '/guilds/' + guildId + '/channels');
    const list = Array.isArray(channels) ? channels : [];
    const marker = 'chatbot:' + input.ownerId + ':' + input.chatId;

    // Recover a channel created before a previous request was interrupted.
    let channel = list.find((item) => item && item.type === 0 && item.topic === marker);

    if (!channel) {
      const slug = username.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 35) || 'user';
      const categoryPrefix = 'user-' + slug + '-' + input.ownerId.slice(0, 8) + '-';
      let category = list.find(
        (item) =>
          item &&
          item.type === 4 &&
          typeof item.name === 'string' &&
          item.name.startsWith(categoryPrefix) &&
          list.filter((child) => child && child.parent_id === item.id).length < 50
      );

      const permissions = [
        { id: guildId, type: 0, allow: '0', deny: '1024' },
        { id: botId, type: 1, allow: '85008', deny: '0' }
      ];

      if (!category) {
        const categoryIndex = list.filter(
          (item) => item && item.type === 4 && typeof item.name === 'string' && item.name.startsWith(categoryPrefix)
        ).length + 1;
        category = await client.request('POST', '/guilds/' + guildId + '/channels', {
          name: categoryPrefix + categoryIndex,
          type: 4,
          permission_overwrites: permissions
        });
      }

      channel = await client.request('POST', '/guilds/' + guildId + '/channels', {
        name: 'chat-' + input.chatId.slice(0, 8),
        type: 0,
        parent_id: category.id,
        topic: marker,
        permission_overwrites: permissions
      });
    }

    return {
      ok: true,
      categoryId: String(channel.parent_id || ''),
      channelId: String(channel.id)
    };
  }

  async function saveMessages(payload) {
    const input = payload || {};
    assertUuid(input.ownerId, 'Mã chủ sở hữu không hợp lệ.');
    assertUuid(input.chatId, 'Mã cuộc chat không hợp lệ.');
    assertSnowflake(input.channelId, 'Mã kênh Discord không hợp lệ.');
    const username = assertUsername(input.username);

    if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 12) {
      throw new ValidationError('Danh sách tin nhắn không hợp lệ hoặc vượt quá giới hạn 12 tin mỗi lần.');
    }

    input.messages.forEach((message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !UUID_RE.test(message.id || '') ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.text !== 'string' ||
        !message.text ||
        message.text.length > 4000 ||
        !Number.isFinite(message.createdAt)
      ) {
        throw new ValidationError('Tin nhắn không hợp lệ.');
      }
    });

    const saved = [];
    for (const message of input.messages) {
      const nonce = crypto
        .createHash('sha256')
        .update(input.ownerId + input.chatId + message.id)
        .digest('hex')
        .slice(0, 24);

      try {
        const result = await client.request('POST', '/channels/' + input.channelId + '/messages', {
          nonce,
          enforce_nonce: true,
          allowed_mentions: { parse: [] },
          embeds: [
            {
              author: { name: message.role === 'user' ? username : 'AI (preview)' },
              description: message.text,
              footer: {
                text: JSON.stringify({
                  app: 'chatbot-v1',
                  id: message.id,
                  role: message.role,
                  createdAt: message.createdAt
                })
              }
            }
          ]
        });
        saved.push({ messageId: message.id, discordId: String(result.id) });
      } catch (error) {
        error.saved = saved;
        throw error;
      }
    }

    return { ok: true, saved };
  }

  async function loadMessages(payload) {
    const input = payload || {};
    assertSnowflake(input.channelId, 'Mã kênh Discord không hợp lệ.');
    if (input.before !== undefined && input.before !== null && input.before !== '') {
      assertSnowflake(input.before, 'Mã phân trang không hợp lệ.');
    }
    const botId = await resolveBotId();
    const query = '/channels/' + input.channelId + '/messages?limit=100' + (input.before ? '&before=' + input.before : '');
    const batch = await client.request('GET', query);
    const list = Array.isArray(batch) ? batch : [];
    const messages = [];

    list.slice().reverse().forEach((message) => {
      if (!message || !message.author || String(message.author.id) !== botId) return;
      const embed = message.embeds && message.embeds[0];
      if (!embed || !embed.footer || typeof embed.footer.text !== 'string') return;
      try {
        const meta = JSON.parse(embed.footer.text);
        if (meta.app !== 'chatbot-v1' || !['user', 'assistant'].includes(meta.role) || typeof embed.description !== 'string') {
          return;
        }
        messages.push({
          id: meta.id,
          role: meta.role,
          text: embed.description,
          createdAt: meta.createdAt
        });
      } catch (_) {
        // Ignore messages not written by the app.
      }
    });

    return {
      ok: true,
      messages,
      before: list.length === 100 ? String(list[list.length - 1].id) : null
    };
  }

  return Object.freeze({ setup, ensureChannel, saveMessages, loadMessages });
}

module.exports = { createDiscordService, ValidationError };
