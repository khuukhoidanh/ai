/** Add DISCORD_BOT_TOKEN and DISCORD_GUILD_ID to Script Properties, then run this once. */
function setupDiscordStorage() {
  discordConfig_();
  return withAdminLock_(function () {
    discordTables_();
    const bot = discordRequest_('get', '/users/@me');
    const config = discordConfig_();
    const guild = discordRequest_('get', '/guilds/' + config.guild);
    PropertiesService.getScriptProperties().setProperty('DISCORD_BOT_ID', bot.id);
    return { ok: true, bot: bot.username, server: guild.name };
  });
}

function discordConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty('DISCORD_BOT_TOKEN');
  const guild = properties.getProperty('DISCORD_GUILD_ID');
  if (!token || !/^\d{17,20}$/.test(guild || '')) throw new Error('Chưa cấu hình DISCORD_BOT_TOKEN / DISCORD_GUILD_ID.');
  return { token: token, guild: guild };
}

function discordRequest_(method, path, data) {
  const config = discordConfig_();
  const options = { method: method, headers: { Authorization: 'Bot ' + config.token }, muteHttpExceptions: true };
  if (data !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(data); }
  const response = UrlFetchApp.fetch('https://discord.com/api/v10' + path, options);
  const status = response.getResponseCode();
  if (status === 429) throw new Error('Discord đang giới hạn tốc độ. Vui lòng đợi rồi thử đồng bộ lại.');
  if (status === 401 || status === 403) throw new Error('Bot Discord thiếu quyền hoặc token không hợp lệ.');
  if (status === 404) throw new Error('Không tìm thấy server hoặc kênh Discord đã lưu.');
  if (status < 200 || status >= 300) throw new Error('Discord không xử lý được yêu cầu (HTTP ' + status + '). Kiểm tra giới hạn kênh và cấu hình bot.');
  return status === 204 ? null : JSON.parse(response.getContentText());
}

function discordTables_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  [
    ['DiscordChats', ['ownerId', 'chatId', 'categoryId', 'channelId', 'title', 'createdAt', 'updatedAt']],
    ['DiscordMessages', ['ownerId', 'chatId', 'messageId', 'discordId']]
  ].forEach(function (definition) {
    let sheet = spreadsheet.getSheetByName(definition[0]);
    if (!sheet) sheet = spreadsheet.insertSheet(definition[0]);
    if (!sheet.getLastRow()) { sheet.appendRow(definition[1]); sheet.setFrozenRows(1); }
  });
  const sheet = getUsersSheet_();
  const headers = sheet.getDataRange().getValues()[0];
  if (!headers.includes('discordOwnerId')) sheet.getRange(1, headers.length + 1).setValue('discordOwnerId');
}

function discordOwner_(token) {
  const session = getSession(token);
  if (!session.ok) throw new Error('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
  const user = userRecords_().find(row => row.username.toLowerCase() === session.user.username.toLowerCase());
  if (!user.discordOwnerId) {
    const sheet = getUsersSheet_();
    const headers = sheet.getDataRange().getValues()[0];
    user.discordOwnerId = Utilities.getUuid();
    sheet.getRange(user.row, headers.indexOf('discordOwnerId') + 1).setValue(user.discordOwnerId);
  }
  return { id: String(user.discordOwnerId), username: user.username };
}

function discordChatRows_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordChats').getDataRange().getValues().slice(1)
    .map((row, index) => ({ ownerId: String(row[0]), id: String(row[1]), categoryId: String(row[2]), channelId: String(row[3]),
      title: String(row[4]), createdAt: Number(row[5]), updatedAt: Number(row[6]), row: index + 2 }));
}

function discordChatPublic_(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
}

function discordHistory_(request) {
  try {
    return withAdminLock_(function () {
      discordConfig_();
      // Authenticate before creating any storage tables or resources.
      if (!getSession(request.token).ok) throw new Error('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
      discordTables_();
      const owner = discordOwner_(request.token);
      let chats = discordChatRows_().filter(chat => chat.ownerId === owner.id);
      if (request.action === 'discordList') return { ok: true, chats: chats.sort((a, b) => b.updatedAt - a.updatedAt).map(discordChatPublic_) };
      const id = request.chatId || (request.chat && request.chat.id);
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Mã cuộc chat không hợp lệ.');
      let chat = chats.find(item => item.id === id);
      if (request.action === 'discordLoad') {
        if (!chat) throw new Error('Không tìm thấy cuộc chat của tài khoản này.');
        return discordLoad_(chat, request.before);
      }
      if (request.action !== 'discordSave') throw new Error('Thao tác không hợp lệ.');
      const input = request.chat;
      if (!input || typeof input.title !== 'string' || input.title.length > 120 || !Array.isArray(input.messages) || input.messages.length > 1000) throw new Error('Dữ liệu chat không hợp lệ hoặc quá lớn.');
      input.messages.forEach(function (message) {
        if (!message || !/^[a-f0-9-]{36}$/i.test(message.id || '') || !['user', 'assistant'].includes(message.role) ||
            typeof message.text !== 'string' || !message.text || message.text.length > 4000 || !Number.isFinite(message.createdAt)) throw new Error('Tin nhắn không hợp lệ.');
      });
      if (!chat) chat = discordCreateChat_(owner, input, chats);
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordMessages');
      const saved = new Set(sheet.getDataRange().getValues().slice(1).filter(row => String(row[0]) === owner.id && String(row[1]) === id).map(row => String(row[2])));
      const pending = input.messages.filter(message => !saved.has(message.id));
      // Keep each execution bounded. The browser can continue with the remaining messages.
      pending.slice(0, 12).forEach(function (message) {
        const nonce = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, owner.id + id + message.id)).slice(0, 24);
        const result = discordRequest_('post', '/channels/' + chat.channelId + '/messages', {
          nonce: nonce, enforce_nonce: true, allowed_mentions: { parse: [] },
          embeds: [{ author: { name: message.role === 'user' ? owner.username : 'AI (preview)' }, description: message.text,
            footer: { text: JSON.stringify({ app: 'chatbot-v1', id: message.id, role: message.role, createdAt: message.createdAt }) } }]
        });
        sheet.appendRow([owner.id, id, message.id, result.id]);
        saved.add(message.id);
      });
      const updatedAt = Date.now();
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordChats').getRange(chat.row, 5, 1, 3)
        .setValues([[sheetText_(input.title || 'New chat'), chat.createdAt, updatedAt]]);
      return { ok: true, remaining: Math.max(0, pending.length - 12), updatedAt: updatedAt };
    });
  } catch (error) {
    // Do not expose UrlFetch errors, which may contain request credentials.
    const message = error.message || '';
    return { ok: false, message: /^(Discord|Bot Discord|Chưa cấu hình|Không tìm thấy|Phiên đăng nhập|Mã cuộc chat|Dữ liệu chat|Tin nhắn)/.test(message)
      ? message : 'Không thể đồng bộ Discord. Kiểm tra cấu hình hoặc thử lại.' };
  }
}

function discordCreateChat_(owner, input, chats) {
  const config = discordConfig_();
  const botId = PropertiesService.getScriptProperties().getProperty('DISCORD_BOT_ID');
  if (!botId) throw new Error('Chưa cấu hình bot: hãy chạy setupDiscordStorage trước.');
  const channels = discordRequest_('get', '/guilds/' + config.guild + '/channels');
  const marker = 'chatbot:' + owner.id + ':' + input.id;
  // Recover a channel created before a previous request was interrupted.
  let channel = channels.find(item => item.type === 0 && item.topic === marker);
  const slug = owner.username.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 35) || 'user';
  const categoryPrefix = 'user-' + slug + '-' + owner.id.slice(0, 8) + '-';
  if (!channel) {
    let category = channels.find(item => item.type === 4 && item.name.startsWith(categoryPrefix) && channels.filter(child => child.parent_id === item.id).length < 50);
    const permissions = [
      { id: config.guild, type: 0, allow: '0', deny: '1024' },
      { id: botId, type: 1, allow: '85008', deny: '0' }
    ];
    if (!category) category = discordRequest_('post', '/guilds/' + config.guild + '/channels', {
      name: categoryPrefix + (channels.filter(item => item.type === 4 && item.name.startsWith(categoryPrefix)).length + 1), type: 4, permission_overwrites: permissions
    });
    channel = discordRequest_('post', '/guilds/' + config.guild + '/channels', {
      name: 'chat-' + input.id.slice(0, 8), type: 0, parent_id: category.id, topic: marker, permission_overwrites: permissions
    });
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordChats');
  const now = Date.now();
  sheet.appendRow([owner.id, input.id, channel.parent_id, channel.id, sheetText_(input.title || 'New chat'), now, now]);
  return { ownerId: owner.id, id: input.id, categoryId: channel.parent_id, channelId: channel.id, createdAt: now, updatedAt: now, title: input.title, row: sheet.getLastRow() };
}

function discordLoad_(chat, before) {
  if (before && !/^\d{17,20}$/.test(before)) throw new Error('Mã cuộc chat không hợp lệ.');
  const batch = discordRequest_('get', '/channels/' + chat.channelId + '/messages?limit=100' + (before ? '&before=' + before : ''));
  const botId = PropertiesService.getScriptProperties().getProperty('DISCORD_BOT_ID');
  const messages = [];
  batch.slice().reverse().forEach(function (message) {
    if (!message.author || message.author.id !== botId) return;
    const embed = message.embeds && message.embeds[0];
    try {
      const meta = JSON.parse(embed.footer.text);
      if (meta.app !== 'chatbot-v1' || !['user', 'assistant'].includes(meta.role) || typeof embed.description !== 'string') return;
      messages.push({ id: meta.id, role: meta.role, text: embed.description, createdAt: meta.createdAt });
    } catch (error) { /* Ignore messages not written by the app. */ }
  });
  return { ok: true, chat: discordChatPublic_(chat), messages: messages, before: batch.length === 100 ? batch[batch.length - 1].id : null };
}
