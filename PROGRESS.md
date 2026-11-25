# Tiến độ Dự án AI Chatbot

Cập nhật lần cuối: **26/11/2026** — Phiên bản hiện tại trên nhánh `main`: **v1.2**

---

## 1. Kiến trúc & Các nhánh hiện có

- **Frontend (GitHub Pages)**: HTML/CSS/JS thuần, tách module giao diện qua `partials/` (`login.html`, `chat.html`, `admin.html`) và `js/views.js`.
- **Backend xác thực & AI (Google Apps Script + Google Sheets)**: Xử lý đăng nhập, phân quyền (`Standard`, `Vip`, `Admin`), quản lý hạn mức lượt hỏi theo ngày (`DailyQuota`), ghi nhận token (`Usage`), nhật ký quản trị (`Audit`), và gọi OpenRouter API từ server.
- **Các nhánh Git**:
  - `main`: Phiên bản chính đang chạy trên GitHub Pages (lưu lịch sử chat cục bộ `localStorage` tối đa 4 MB + quota phía server + OpenRouter `Auto (Free)`).
  - `feature/api_bot`: Nhánh phát triển tích hợp OpenRouter API.
  - `feature/databases`: Nhánh lưu trữ lịch sử chat qua Discord REST API + Node.js Bridge (`server/`), tạm tách riêng để dùng khi triển khai server/VPS.

---

## 2. Các hạng mục đã hoàn thành

### Giao diện & Trải nghiệm Chat
- [x] Tách [index.html](index.html) thành các file nhỏ trong `partials/` (`login.html`, `chat.html`, `admin.html`) nạp qua `js/views.js`.
- [x] Chuyển bộ chọn model AI xuống thanh điều khiển của khung nhập chat.
- [x] Mở chế độ **`Auto (Free)`** (`openrouter/free` có dự phòng tự động giữa các model miễn phí); khoá 3 model trả phí (`gpt-oss-120b`, `Gemini 2.5 Flash Lite`, `DeepSeek V4 Flash 0731`).
- [x] Khoá nút gửi & `Enter` khi bot đang trả lời (vẫn cho phép gõ tiếp nội dung mới), kèm timeout 60 giây.
- [x] Hiển thị tên model thực tế đã trả lời bên dưới mỗi tin nhắn bot.
- [x] Hỗ trợ hiển thị Markdown đầy đủ: tiêu đề `h1`–`h4`, **in đậm** / *in nghiêng*, danh sách, đường kẻ ngang, bảng có viền, trích dẫn dạng hộp (`blockquote`), và khung code có nút **Copy**.
- [x] Nâng cỡ chữ toàn giao diện cho dễ đọc; thêm icon quả chanh (`favicon.svg` + sidebar).
- [x] Chặn lỗi tự submit form ra `?` ở cuối URL (`js/views.js`).

### Lưu trữ cục bộ & Quản lý phiên (nhánh `main`)
- [x] Lưu lịch sử chat trên `localStorage` với giới hạn **4 MB / tài khoản** kèm bộ đếm dung lượng trên khung nhập.
- [x] Chế độ 1 phiên trò chuyện: bấm `+ New chat` hỏi xác nhận xoá phiên cũ trước khi tạo mới; tự động nhắc khi dung lượng còn dưới 1 MB (`>= 3 MB / 4 MB`).

### Quota, Quản trị & Bảo mật
- [x] **Server-side Daily Quota**: Bỏ hoàn toàn lưu/đếm quota ở `localStorage`; kiểm tra và cập nhật `usedCount` trực tiếp trên Google Sheets (`DailyQuota`) theo múi giờ cấu hình (`Asia/Ho_Chi_Minh`).
- [x] Bảo vệ chống trừ oan khi AI lỗi, chống gửi trùng (`clientRequestId`), và chống vượt quota khi gửi đồng thời.
- [x] Cho phép Admin chỉnh và đồng bộ **Giới hạn lượt hỏi mỗi ngày** trực tiếp trong **Quản trị > Hệ thống** (`Script Properties`).
- [x] Thêm **Content-Security-Policy (CSP)** trong `index.html`.
- [x] Bổ sung chống brute-force đăng nhập (khoá tạm 5 phút sau 5 lần sai liên tiếp) và khoá đồng bộ khi ghi `lastLogin` ở backend Apps Script.
- [x] System prompt yêu cầu AI trả lời đúng ngôn ngữ người dùng và trình bày Markdown rõ ràng.

### CI/CD & Triển khai
- [x] Sửa workflow GitHub Pages (`.github/workflows/static.yml`) thành 2 job tách biệt `build` → `deploy` (`needs: build`) với `actions/upload-pages-artifact@v4` và `actions/deploy-pages@v5`.
- [x] Giữ `apps-script/` và `tests/` loại trừ khỏi GitHub qua `.gitignore`.

---

## 3. Giới hạn hiện tại (đã ghi nhận)

- Chưa hỗ trợ tìm kiếm Internet thời gian thực (tin tức/giá cả trong ngày).
- Chưa mở tính năng đính kèm ảnh/tệp ở nút `+`.
- Lịch sử chat trên `main` mới lưu cục bộ trên trình duyệt (tối đa 4 MB, 1 phiên tại một thời điểm).
- Các file trong `apps-script/` cần được copy và **Deploy > New version** thủ công trên Google Apps Script mỗi khi có thay đổi backend.

---

## 4. Kế hoạch tiếp theo (Đề xuất)

- [ ] Thêm nút **Copy câu trả lời** và **Thử lại (Regenerate)** dưới mỗi tin nhắn bot.
- [ ] Thêm hệ thống **Skill (chế độ chuyên biệt)**: Code & Debug, Tóm tắt nhanh, Dịch thuật, Viết Email/Bài đăng.
- [ ] Tích hợp tìm tin mới miễn phí (bật/tắt qua Google News RSS trên Apps Script) hoặc đọc file text/code ở nút `+`.
- [ ] Cho phép người dùng tự đổi mật khẩu cá nhân.
- [ ] Khi có VPS/Cloudflare Workers, hợp nhất nhánh `feature/databases` để lưu nhiều cuộc trò chuyện lên cloud.
