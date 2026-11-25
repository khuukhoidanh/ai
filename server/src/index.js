'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { createDiscordClient } = require('./discord-client');
const { createDiscordService } = require('./discord-service');
const { createApp } = require('./app');

function start() {
  const config = loadConfig();
  const client = createDiscordClient({
    botToken: config.botToken,
    apiBase: config.apiBase,
    requestTimeoutMs: config.requestTimeoutMs
  });
  const service = createDiscordService({
    client,
    guildId: config.guildId,
    botId: config.botId
  });
  const app = createApp({
    service,
    bridgeSecret: config.bridgeSecret,
    maxBodyBytes: config.maxBodyBytes
  });

  const server = http.createServer(app);
  server.listen(config.port, () => {
    console.log(`Discord bridge listening on port ${config.port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };
