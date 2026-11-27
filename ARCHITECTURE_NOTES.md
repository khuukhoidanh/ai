# Ghi chú kiến trúc lưu trữ và triển khai

## Mục tiêu

Tách riêng nơi phục vụ giao diện, API backend và nơi lưu dữ liệu để ứng dụng dễ bảo vệ thông tin và có thể thay đổi khi lượng người dùng tăng.

## Hướng kiến trúc đề xuất

- **Frontend:** tiếp tục lưu mã nguồn giao diện trong GitHub repo và triển khai website tĩnh bằng GitHub Pages.
- **Backend/API:** dùng một dịch vụ backend/serverless riêng để xác thực người dùng, kiểm tra quyền, xử lý yêu cầu chat và gọi các dịch vụ bên ngoài.
- **Database:** backend kết nối tới database phù hợp; không dùng nội dung của GitHub repo làm nơi lưu tài khoản, lịch sử chat hoặc dữ liệu vận hành.
- **Secrets:** API key, token và thông tin kết nối database chỉ được lưu ở cấu hình bí mật phía server; tuyệt đối không nhúng vào JavaScript gửi cho trình duyệt.

## Vì sao không lưu dữ liệu trực tiếp trong repo

GitHub repo được thiết kế để lưu mã nguồn và lịch sử thay đổi, không phải database ứng dụng. Ghi dữ liệu qua GitHub API từ trình duyệt sẽ làm lộ token có quyền ghi repo. Nếu phải tạo backend trung gian để giữ token, backend đó vẫn cần một nơi lưu dữ liệu phù hợp; thao tác ghi thành commit cũng không thay thế được truy vấn và cập nhật dữ liệu kiểu database.

## Phương án theo ngân sách

Hiện tại có thể tiếp tục dùng Google Apps Script + Google Sheets cho giai đoạn nhỏ, không cần chuyển ngay. Nếu cần tách backend và database sau này, có thể khảo sát dịch vụ serverless/database có gói miễn phí, chẳng hạn Cloudflare Workers + D1 hoặc dịch vụ tương đương.

Gói miễn phí có thể thay đổi và thường có giới hạn. Trước khi chọn dịch vụ cần kiểm tra điều khoản, quota hiện hành, nơi lưu dữ liệu, khả năng sao lưu/khôi phục và cách quản lý secrets. Chưa chọn dịch vụ cụ thể và chưa xác minh quota của bất kỳ tài khoản nào.

## Lộ trình chuyển đổi gợi ý

1. Xác định dữ liệu cần lưu, thời gian lưu giữ và quyền truy cập cho từng loại dữ liệu.
2. Chọn backend/database dựa trên chi phí, quota, bảo mật và khả năng sao lưu.
3. Thiết kế API server-side; mọi xác thực và phân quyền phải được kiểm tra ở backend.
4. Di chuyển dữ liệu có kiểm soát; không đưa dữ liệu thật hoặc secrets vào Git.
5. Chạy test, kiểm tra quyền truy cập, sao lưu/khôi phục và giới hạn sử dụng trước khi chuyển người dùng.
6. Giữ phương án quay lui cho tới khi xác nhận dữ liệu và chức năng hoạt động đúng.

## Nguyên tắc bảo mật

- Không lưu mật khẩu dạng rõ; dùng cơ chế băm mật khẩu phù hợp hoặc dịch vụ xác thực chuyên dụng.
- Không lưu API key, token phiên hoặc credentials trong frontend hay repo.
- Không tin dữ liệu từ client; backend phải xác thực đầu vào và kiểm tra quyền trên từng thao tác.
- Hạn chế dữ liệu cá nhân, đặt chính sách lưu/xóa dữ liệu và sao lưu an toàn.
- Không chuyển production hoặc thay đổi dữ liệu thật khi chưa có kế hoạch kiểm thử và khôi phục.
