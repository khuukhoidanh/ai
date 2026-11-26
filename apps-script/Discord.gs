/** Add DISCORD_BRIDGE_URL and DISCORD_BRIDGE_SECRET to Script Properties, then run this once. */
function setupDiscordStorage() {
  discordBridgeConfig_();
  return withAdminLock_(function () {
    discordTables_();
    const result = discordBridgeRequest_('/api/discord/setup', {});
    if (result.botId) {
      PropertiesService.getScriptProperties().setProperty('DISCORD_BOT_ID', String(result.botId));
    }
    return { ok: true, bot: result.bot, server: result.server };
  });
}

function discordBridgeConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const url = String(properties.getProperty('DISCORD_BRIDGE_URL') || '').trim().replace(/\/+$/, '');
  const secret = String(properties.getProperty('DISCORD_BRIDGE_SECRET') || '').trim();
  if (!/^https?:\/\/.+/i.test(url) || !secret) {
    throw new Error('Chưa cấu hình DISCORD_BRIDGE_URL / DISCORD_BRIDGE_SECRET.');
  }
  return { url: url, secret: secret };
}

function discordBridgeRequest_(path, data) {
  const config = discordBridgeConfig_();
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Bridge-Secret': config.secret },
    payload: JSON.stringify(data === undefined ? {} : data),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(config.url + path, options);
  const status = response.getResponseCode();
  let parsed = null;
  try {
    parsed = JSON.parse(response.getContentText() || '{}');
  } catch (error) {
    parsed = null;
  }
  if (status === 401 || status === 403) {
    const err = new Error((parsed && parsed.message) || 'Không thể xác thực với dịch vụ đồng bộ Discord.');
    if (parsed && Array.isArray(parsed.saved)) err.saved = parsed.saved;
    throw err;
  }
  if (status === 429) {
    const err = new Error((parsed && parsed.message) || 'Discord đang giới hạn tốc độ. Vui lòng đợi rồi thử đồng bộ lại.');
    if (parsed && Array.isArray(parsed.saved)) err.saved = parsed.saved;
    throw err;
  }
  if (status < 200 || status >= 300 || !parsed || !parsed.ok) {
    const err = new Error((parsed && parsed.message) || ('Dịch vụ đồng bộ Discord lỗi (HTTP ' + status + ').'));
    if (parsed && Array.isArray(parsed.saved)) err.saved = parsed.saved;
    throw err;
  }
  return parsed;
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
      discordBridgeConfig_();
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
      if (!chat) chat = discordCreateChat_(owner, input);
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordMessages');
      const saved = new Set(sheet.getDataRange().getValues().slice(1).filter(row => String(row[0]) === owner.id && String(row[1]) === id).map(row => String(row[2])));
      const pending = input.messages.filter(message => !saved.has(message.id));
      const batch = pending.slice(0, 12);
      if (batch.length > 0) {
        try {
          const result = discordBridgeRequest_('/api/discord/messages/save', {
            ownerId: owner.id,
            username: owner.username,
            chatId: id,
            channelId: chat.channelId,
            messages: batch
          });
          (result.saved || []).forEach(function (item) {
            sheet.appendRow([owner.id, id, item.messageId, item.discordId]);
            saved.add(item.messageId);
          });
        } catch (error) {
          if (Array.isArray(error.saved)) {
            error.saved.forEach(function (item) {
              sheet.appendRow([owner.id, id, item.messageId, item.discordId]);
              saved.add(item.messageId);
            });
          }
          throw error;
        }
      }
      const updatedAt = Date.now();
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordChats').getRange(chat.row, 5, 1, 3)
        .setValues([[sheetText_(input.title || 'New chat'), chat.createdAt, updatedAt]]);
      return { ok: true, remaining: Math.max(0, pending.length - 12), updatedAt: updatedAt };
    });
  } catch (error) {
    // Do not expose UrlFetch errors, which may contain request credentials.
    const message = error.message || '';
    return { ok: false, message: /^(Discord|Bot Discord|Dịch vụ đồng bộ Discord|Không thể xác thực|Chưa cấu hình|Không tìm thấy|Phiên đăng nhập|Mã cuộc chat|Dữ liệu chat|Tin nhắn)/.test(message)
      ? message : 'Không thể đồng bộ Discord. Kiểm tra cấu hình hoặc thử lại.' };
  }
}

function discordCreateChat_(owner, input) {
  const result = discordBridgeRequest_('/api/discord/channels/ensure', {
    ownerId: owner.id,
    username: owner.username,
    chatId: input.id,
    title: input.title || 'New chat'
  });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DiscordChats');
  const now = Date.now();
  sheet.appendRow([owner.id, input.id, result.categoryId, result.channelId, sheetText_(input.title || 'New chat'), now, now]);
  return { ownerId: owner.id, id: input.id, categoryId: result.categoryId, channelId: result.channelId, createdAt: now, updatedAt: now, title: input.title, row: sheet.getLastRow() };
}

function discordLoad_(chat, before) {
  if (before && !/^\d{17,20}$/.test(before)) throw new Error('Mã cuộc chat không hợp lệ.');
  const result = discordBridgeRequest_('/api/discord/messages/load', {
    channelId: chat.channelId,
    before: before || null
  });
  return { ok: true, chat: discordChatPublic_(chat), messages: result.messages || [], before: result.before || null };
}
