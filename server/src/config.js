'use strict';

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid numeric environment configuration.');
  }
  return parsed;
}

function loadConfig(env = process.env) {
  const botToken = String(env.DISCORD_BOT_TOKEN || '').trim();
  const guildId = String(env.DISCORD_GUILD_ID || '').trim();
  const bridgeSecret = String(env.DISCORD_BRIDGE_SECRET || '').trim();
  const botId = String(env.DISCORD_BOT_ID || '').trim();
  const apiBase = String(env.DISCORD_API_BASE || 'https://discord.com/api/v10').trim().replace(/\/+$/, '');

  if (!botToken) {
    throw new Error('Missing required environment variable: DISCORD_BOT_TOKEN');
  }
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new Error('Missing or invalid environment variable: DISCORD_GUILD_ID');
  }
  if (!bridgeSecret || bridgeSecret.length < 16) {
    throw new Error('Missing or too-short environment variable: DISCORD_BRIDGE_SECRET (minimum 16 characters)');
  }
  if (botId && !/^\d{17,20}$/.test(botId)) {
    throw new Error('Invalid environment variable: DISCORD_BOT_ID');
  }

  return Object.freeze({
    port: parsePositiveInt(env.PORT, 3000),
    botToken,
    guildId,
    bridgeSecret,
    botId: botId || null,
    apiBase,
    requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15000),
    maxBodyBytes: parsePositiveInt(env.MAX_BODY_BYTES, 262144)
  });
}

module.exports = { loadConfig };
