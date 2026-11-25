# Node.js Discord Bridge — Hướng dẫn chạy & Deploy

Dịch vụ Node.js này làm cầu nối (bridge) giữa Google Apps Script và Discord REST API v10 để tránh lỗi chặn mạng `40333 internal network error` từ hạ tầng Google Apps Script.

## 1. Biến môi trường

Xem mẫu tại `server/.env.example`:

- `PORT` (mặc định `3000`): cổng HTTP server lắng nghe.
- `DISCORD_BOT_TOKEN` (bắt buộc): Bot Token của ứng dụng Discord. **Tuyệt đối không** đưa vào frontend, Git hoặc log.
- `DISCORD_GUILD_ID` (bắt buộc): ID Discord Server (17–20 chữ số).
- `DISCORD_BRIDGE_SECRET` (bắt buộc, tối thiểu 16 ký tự): chuỗi bí mật dùng chung giữa Apps Script và Node.js.
- `DISCORD_BOT_ID` (tuỳ chọn): Bot User ID; nếu bỏ trống backend sẽ tự lấy từ `/users/@me`.
- `REQUEST_TIMEOUT_MS` (tuỳ chọn, mặc định `15000`): timeout cho mỗi request tới Discord.
- `MAX_BODY_BYTES` (tuỳ chọn, mặc định `262144`): giới hạn kích thước JSON body.

## 2. Chạy local

```powershell
cd d:\Job\ai\server
$env:DISCORD_BOT_TOKEN="<bot-token>"
$env:DISCORD_GUILD_ID="<guild-id>"
$env:DISCORD_BRIDGE_SECRET="<shared-secret-min-16-chars>"
npm start
```

Kiểm tra healthcheck:
```powershell
Invoke-RestMethod http://localhost:3000/health
```

## 3. Chạy test (mock Discord API, không gửi request thật)

Từ thư mục gốc `d:\Job\ai`:
```powershell
node --test tests/admin-backend.test.cjs tests/discord-bridge.test.cjs
```

## 4. Deploy thủ công (Render / Railway / Fly.io / VPS)

1. Tạo Web Service trỏ tới thư mục `server/` (hoặc root với Root Directory = `server`), Build Command: *(không cần hoặc `npm install --omit=dev`)*, Start Command: `npm start` (hoặc `node src/index.js`).
2. Yêu cầu Node.js >= 20 (không cần thư viện npm ngoài).
3. Khai báo các biến môi trường `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_BRIDGE_SECRET` trên trang quản trị của host.
4. Kiểm tra `GET https://<your-bridge-domain>/health` trả về `{"ok":true,"service":"discord-bridge"}`.
5. Trong Google Apps Script > **Project Settings > Script Properties**, thêm:
   - `DISCORD_BRIDGE_URL`: `https://<your-bridge-domain>` (không có dấu `/` ở cuối)
   - `DISCORD_BRIDGE_SECRET`: đúng giá trị `DISCORD_BRIDGE_SECRET` đã cấu hình trên Node.js.
6. Cập nhật file `Discord.gs` trong Apps Script bằng nội dung `apps-script/Discord.gs`, chạy `setupDiscordStorage()` một lần, rồi **Deploy > Manage deployments > Edit > New version > Deploy**.
