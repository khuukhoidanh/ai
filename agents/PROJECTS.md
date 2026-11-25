## Dự án chatbot AI của Khuukhoidanh

## Mục tiêu
- Đây là bài thực tế/báo cáo cuối năm cho môn Lập trình Web Full-Stack.
- Cung cấp chatbot AI cho bạn bè và những người được chủ dự án cấp quyền sử dụng.
- Hỗ trợ các tác vụ thông thường như làm bài đơn giản, tóm tắt văn bản, viết báo cáo, lên ý tưởng và lập trình cơ bản.

## Tài khoản và quyền truy cập
- Chủ dự án tự tạo tài khoản và cấp cho người dùng.
- Danh sách tài khoản được xác minh dựa trên file Excel.
- Cần xác định cấu trúc các cột, nơi lưu file và cách backend đọc/cập nhật danh sách. Không đưa dữ liệu tài khoản hoặc thông tin xác thực vào mã nguồn hay log.
- Backend phải kiểm tra quyền sử dụng ở phía server trước khi xử lý yêu cầu AI.

## Nhà cung cấp AI và model
- Backend sử dụng Google AI API. Thông tin OpenRouter trong bản mô tả ban đầu không còn là lựa chọn hiện tại.
- Người dùng có thể chọn giữa các model được hệ thống cung cấp.
- Chủ dự án sẽ bổ sung danh sách model sau; không tự giả định model hoặc bật model chưa được cấu hình.
- Một số model có thể tính phí. Model trả phí cần có giới hạn token; mức giới hạn cụ thể sẽ được quyết định sau. Không tự đặt mức giới hạn hoặc chính sách chi phí.
- Hạn mức của nhà cung cấp phụ thuộc tài khoản Google AI và model thực tế; cần kiểm tra cấu hình/hạn mức hiện hành trước khi triển khai.

## Giới hạn sử dụng
- Hệ thống áp dụng tối đa 200 request mỗi tài khoản trong một ngày.
- Quota hằng ngày được reset lúc 00:00 UTC, tương ứng 07:00 sáng tại Việt Nam (UTC+7).
- Có timeout một phút giữa các request trong cùng một session website. Đây là giới hạn theo session, không phải theo tài khoản hay toàn hệ thống.
- Backend phải kiểm soát quota; không dựa vào bộ đếm phía trình duyệt. Cần tránh để các request đồng thời vượt quota.
- Khi quota hết, hành vi cụ thể (chặn request hay cho phép chọn model trả phí) phải theo chính sách được cấu hình. Việc sử dụng model trả phí phải được giới hạn token và thông báo rõ cho người dùng.

## Lịch sử hội thoại và dữ liệu
- Hệ thống lưu lịch sử hội thoại để người dùng xem lại.
- Người dùng không có chức năng tự xóa lịch sử.
- Cần xác định thời hạn lưu và quy trình quản trị/xóa dữ liệu khi cần; bảo vệ dữ liệu trong database và bản sao lưu.
- Nội dung prompt và câu trả lời có thể chứa dữ liệu nhạy cảm. Không ghi toàn bộ nội dung hội thoại, API key hoặc token vào log mặc định.

## Yêu cầu kỹ thuật và bảo mật
- Backend gọi Google AI API; không gọi trực tiếp từ trình duyệt bằng API key bí mật.
- Lưu API key và secrets trong biến môi trường hoặc hệ thống quản lý secrets; không commit vào repository, đưa vào phản hồi API hoặc ghi vào log.
- Xác thực và phân quyền, kiểm tra quota, kiểm tra dữ liệu đầu vào và xử lý lỗi phải được thực hiện ở backend.
- Lỗi từ Google AI API, timeout, hết hạn mức hoặc model không khả dụng cần được xử lý an toàn, không để lộ stack trace hay thông tin bí mật.
- Công nghệ, database, cơ chế đăng nhập cụ thể và nơi triển khai chưa được xác định. Kiểm tra repository hoặc hỏi chủ dự án trước khi chốt.

## Tiêu chí hoàn thành chức năng chatbot
- Chỉ tài khoản được cấp phép mới gửi được yêu cầu AI.
- Quota 200 request/tài khoản/ngày được áp dụng phía server và reset theo mốc 00:00 UTC.
- Khoảng cách một phút giữa request được áp dụng trong phạm vi session website.
- API key không xuất hiện trong frontend, phản hồi API, log hoặc repository.
- Model người dùng chọn phải thuộc danh sách cấu hình; model trả phí tuân theo giới hạn token đã được chủ dự án quyết định.
- Lịch sử hội thoại được lưu và người dùng không thể tự xóa.
- Có kiểm thử cho luồng thành công, tài khoản không được cấp phép, hết quota, request quá nhanh, lỗi/timeout nhà cung cấp và model không khả dụng.

## Các quyết định còn mở
- Cấu trúc file Excel, cách bảo vệ và đồng bộ danh sách tài khoản.
- Danh sách model Google AI được cung cấp và model nào miễn phí/trả phí.
- Giới hạn token, ngân sách và hành vi khi quota miễn phí hết.
- Thời hạn lưu lịch sử hội thoại và quy trình xóa dữ liệu quản trị.
- Công nghệ backend, database và phương thức triển khai.
