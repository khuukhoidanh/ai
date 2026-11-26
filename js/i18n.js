(function () {
  'use strict';

  const STORAGE_KEY = 'chatbot.lang';
  const listeners = [];

  const DICT = {
    vi: {
      // Common / Lang switch
      'lang.switchAria': 'Đổi ngôn ngữ (Tiếng Việt / English)',
      'common.cancel': 'Huỷ',
      'common.saveChanges': 'Lưu thay đổi',
      'common.saving': 'Đang lưu…',
      'common.loading': 'Đang tải…',
      'common.notLoaded': 'Chưa tải dữ liệu',
      'common.loadError': 'Chưa tải được',

      // Session restore & Auth
      'restore.aria': 'Khôi phục phiên đăng nhập',
      'restore.title': 'Chatbot AI',
      'restore.checking': 'Đang khôi phục phiên đăng nhập…',
      'restore.retry': 'Thử lại',
      'restore.relogin': 'Đăng nhập lại',
      'restore.networkError': 'Chưa kết nối được máy chủ. Phiên đăng nhập vẫn được lưu, bạn có thể thử lại.',
      'restore.expired': 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',

      'auth.modeAria': 'Chế độ tài khoản',
      'auth.tabLogin': 'Đăng nhập',
      'auth.tabRegister': 'Đăng ký',
      'auth.loginTitle': 'LOGIN PAGE',
      'auth.registerTitle': 'REGISTER',
      'auth.usernameLabel': 'Tên đăng nhập',
      'auth.usernamePlaceholder': 'Username',
      'auth.passwordLabel': 'Mật khẩu',
      'auth.passwordPlaceholder': 'Password',
      'auth.showPassword': 'Show',
      'auth.hidePassword': 'Hide',
      'auth.showPasswordAria': 'Hiện mật khẩu',
      'auth.hidePasswordAria': 'Ẩn mật khẩu',
      'auth.loginBtn': 'Đăng nhập',
      'auth.loggingInBtn': 'Đang đăng nhập…',
      'auth.verifyingBtn': 'Đang xác thực…',
      'auth.discordIdLabel': 'Discord ID',
      'auth.discordIdPlaceholder': 'Discord ID (17–20 chữ số)',
      'auth.regPasswordPlaceholder': 'Mật khẩu (tối thiểu 8 ký tự)',
      'auth.confirmPasswordLabel': 'Xác nhận mật khẩu',
      'auth.confirmPasswordPlaceholder': 'Xác nhận mật khẩu',
      'auth.registerNote': 'Bạn cần tham gia máy chủ Discord trước khi đăng ký.',
      'auth.registerBtn': 'Đăng ký',
      'auth.registeringBtn': 'Đang xác minh…',

      // Chat
      'chat.collapseSidebar': 'Thu gọn thanh bên',
      'chat.closeSidebar': 'Đóng thanh bên',
      'chat.openSidebar': 'Mở điều hướng',
      'chat.newChat': 'New chat',
      'chat.recent': 'RECENT',
      'chat.historySync': 'Lưu trên trình duyệt (tối đa 4 MB)',
      'chat.dailyRequests': 'Daily requests',
      'chat.newConversation': 'New conversation',
      'chat.adminBtn': 'Quản trị',
      'chat.logoutAria': 'Đăng xuất',
      'chat.inputLabel': 'Nhập tin nhắn',
      'chat.inputPlaceholder': 'Ask anything, or dream up something new...',
      'chat.attachAria': 'Không hỗ trợ đính kèm tệp',
      'chat.storageTitle': 'Giới hạn dữ liệu chat lưu trên trình duyệt: tối đa 4 MB',
      'chat.modelGroupFree': 'Miễn phí (Free)',
      'chat.modelGroupLocked': 'Trả phí (Đã khoá)',
      'chat.modelAuto': 'Auto (Free)',
      'chat.modelLockedGpt': '🔒 gpt-oss-120b (Đã khoá)',
      'chat.modelLockedGemini': '🔒 Gemini 2.5 Flash Lite (Đã khoá)',
      'chat.modelLockedDeepseek': '🔒 DeepSeek V4 Flash 0731 (Đã khoá)',
      'chat.sendAria': 'Gửi tin nhắn',
      'chat.respondingAria': 'Bot đang trả lời…',
      'chat.disclaimer': 'AI can make mistakes. Please double-check important information.',
      'chat.typingAria': 'Đang trả lời',
      'chat.copy': 'Copy',
      'chat.copied': 'Copied!',

      // Session choice modal
      'modal.newChatTitle': 'Xoá phiên trò chuyện cũ?',
      'modal.newChatDesc': 'Hiện tại chỉ dùng 1 phiên trò chuyện duy nhất (<strong id="session-choice-summary"></strong>). Bạn có muốn xoá toàn bộ đoạn chat cũ để tạo phiên mới không?',
      'modal.newChatConfirm': 'Xoá & tạo mới',
      'modal.newChatKeep': 'Giữ lại phiên cũ',
      'modal.lowSpaceTitle': 'Dung lượng chat sắp đầy',
      'modal.lowSpaceDesc': 'Dữ liệu chat đã dùng <strong id="session-choice-summary"></strong> (chỉ còn dưới 1 MB). Bạn muốn tiếp tục bản cũ hay xoá để sang bản mới?',
      'modal.lowSpaceSummary': '{count} cuộc trò chuyện • {used}',
      'modal.lowSpaceNew': 'Sang bản mới',
      'modal.lowSpaceContinue': 'Tiếp tục bản cũ',

      // App notifications & errors
      'msg.enterBoth': 'Vui lòng nhập tên đăng nhập và mật khẩu.',
      'msg.enterUsername': 'Vui lòng nhập tên đăng nhập.',
      'msg.enterPassword': 'Vui lòng nhập mật khẩu.',
      'msg.loginSlow': 'Hệ thống vẫn đang xử lý đăng nhập. Bạn vui lòng chờ thêm một chút.',
      'msg.loginFailed': 'Không thể đăng nhập. Vui lòng thử lại.',
      'msg.loginSuccess': 'Đăng nhập thành công.',
      'msg.loginNoStorage': 'Đăng nhập thành công. Trình duyệt không cho phép lưu phiên đăng nhập.',
      'msg.loginConnectError': 'Không thể kết nối hệ thống đăng nhập. Vui lòng thử lại.',
      'msg.invalidDiscordId': 'Discord ID phải gồm 17 đến 20 chữ số.',
      'msg.invalidUsername': 'Tên đăng nhập không hợp lệ (không bắt đầu bằng =, +, @, -).',
      'msg.invalidPasswordLen': 'Mật khẩu cần từ 8 đến 256 ký tự.',
      'msg.passwordMismatch': 'Mật khẩu xác nhận không khớp.',
      'msg.registerFailed': 'Không thể đăng ký tài khoản. Vui lòng thử lại.',
      'msg.registerSuccess': 'Đăng ký thành công. Bạn có thể đăng nhập ngay.',
      'msg.registerUnavailable': 'Hệ thống xác minh đăng ký tạm thời không khả dụng. Vui lòng thử lại sau.',
      'msg.botResponding': 'Bot đang trả lời, vui lòng đợi phản hồi xong trước khi gửi tin mới.',
      'msg.botRespondingNewChat': 'Bot đang trả lời, vui lòng đợi xong trước khi tạo phiên mới.',
      'msg.botRespondingEnter': 'Bot đang trả lời, bạn vẫn có thể nhập tiếp nhưng chưa thể gửi.',
      'msg.quotaReached': 'Bạn đã dùng hết {limit} lượt hỏi trong ngày hôm nay. Vui lòng quay lại vào ngày mai.',
      'msg.storageFull': 'Đã đạt giới hạn 4 MB dữ liệu chat trên trình duyệt. Vui lòng tạo bản mới để tiếp tục.',
      'msg.storageWriteError': 'Không lưu được lịch sử trên trình duyệt. Dung lượng có thể đã đầy hoặc quyền lưu trữ bị chặn.',
      'msg.storageReadError': 'Không đọc được lịch sử đã lưu trên trình duyệt.',
      'msg.aiError': 'Không thể nhận phản hồi từ OpenRouter.',
      'msg.emptyBotReply': '(Bot không trả về nội dung.)',
      'msg.logoutRemoteError': 'Đã thoát trên trình duyệt nhưng chưa thu hồi được phiên trên máy chủ.',
      'msg.adminLoadError': 'Hãy cập nhật backend và chạy setupAdminSheets.',
      'msg.adminExpired': 'Phiên đã hết hạn hoặc không có quyền quản trị. Vui lòng đăng nhập lại.',
      'msg.adminConfirmed': 'Kết nối và quyền quản trị đã được xác nhận.',
      'msg.modelLocked': 'Model trả phí đang bị khoá. Chỉ có thể dùng chế độ Auto miễn phí.',
      'msg.modelSelected': 'Đã chọn model: {label}',
      'msg.clearedChat': 'Đã xoá dữ liệu cũ và tạo cuộc trò chuyện mới.',
      'msg.cryptoUnsupported': 'Trình duyệt không hỗ trợ tạo mã ngẫu nhiên an toàn.',

      // API / Views
      'api.missingUrl': 'Vui lòng cấu hình URL Web App Google Apps Script trong js/config.js.',
      'api.timeout': 'Hệ thống phản hồi quá lâu (timeout). Vui lòng thử lại.',
      'api.network': 'Không thể kết nối hệ thống máy chủ. Hãy kiểm tra URL và quyền truy cập Web App.',
      'views.initError': 'Không thể tải giao diện ứng dụng. Vui lòng tải lại trang.',

      // Admin HTML & JS
      'admin.navAria': 'Điều hướng quản trị',
      'admin.workspaceTitle': 'Admin workspace',
      'admin.workspaceSub': 'Quản lý ứng dụng',
      'admin.navOverview': 'Tổng quan',
      'admin.navAnalytics': 'Sử dụng AI',
      'admin.navUsers': 'Quản lý tài khoản',
      'admin.navCreate': 'Tạo tài khoản mới',
      'admin.navSystem': 'Hệ thống',
      'admin.navAudit': 'Nhật ký hoạt động',
      'admin.sidebarFooter': 'Không gian quản trị',
      'admin.backChat': 'Về chat',
      'admin.refreshBtn': 'Làm mới dữ liệu',
      'admin.summaryHeading': 'Thống kê sử dụng',
      'admin.allTime': 'Toàn bộ thời gian',
      'admin.allTimeShort': 'Toàn thời gian',
      'admin.statTotalUsers': 'Tổng tài khoản',
      'admin.statTokensUsed': 'Token AI đã sử dụng',
      'admin.statInputTokens': 'Token đầu vào',
      'admin.statInputSub': 'Nội dung gửi đến mô hình AI',
      'admin.statOutputTokens': 'Token đầu ra',
      'admin.statOutputSub': 'Nội dung mô hình AI phản hồi',
      'admin.chartTokenTitle': 'Phân bổ token AI',
      'admin.chartTokenSub': '8 tài khoản sử dụng nhiều nhất',
      'admin.legendInput': 'Đầu vào',
      'admin.legendOutput': 'Đầu ra',
      'admin.chartRoleTitle': 'Nhóm người dùng',
      'admin.chartRoleSub': 'Phân bổ theo quyền tài khoản',
      'admin.accountsUnit': 'tài khoản',
      'admin.systemStatusTitle': 'Trạng thái hệ thống',
      'admin.loginApiLabel': 'API đăng nhập',
      'admin.apiUnchecked': 'Chưa kiểm tra',
      'admin.apiChecking': 'Đang kiểm tra…',
      'admin.apiConnected': 'Đã kết nối',
      'admin.apiDisconnected': 'Không thể kết nối',
      'admin.lastCheckedLabel': 'Kiểm tra gần nhất',
      'admin.aiServiceLabel': 'Dịch vụ AI',
      'admin.storageLabel': 'Lưu trữ tài khoản',
      'admin.rolesQuotaTitle': 'Phân quyền tài khoản & Hạn mức',
      'admin.rolesQuotaDesc': '<strong>Standard</strong> — tài khoản thông thường.<br><strong>Vip</strong> — nhóm tài khoản nâng cao.<br><strong>Admin</strong> — quản lý người dùng và xem thống kê.',
      'admin.usageNote': 'Token chỉ được ghi nhận từ phản hồi thực tế của dịch vụ AI, không tính từ tin nhắn demo.',
      'admin.dailyLimitLabel': 'Giới hạn lượt hỏi mỗi ngày (Daily requests)',
      'admin.saveLimitBtn': 'Lưu giới hạn',
      'admin.userListTitle': 'Danh sách tài khoản',
      'admin.searchAccount': 'Tìm tài khoản',
      'admin.roleLabel': 'Quyền',
      'admin.roleAll': 'Tất cả',
      'admin.colAccount': 'Tài khoản',
      'admin.colRole': 'Quyền',
      'admin.colStatus': 'Trạng thái',
      'admin.colTokens': 'Token vào / ra',
      'admin.colLastLogin': 'Đăng nhập gần nhất',
      'admin.colActions': 'Thao tác',
      'admin.createTitle': 'Thông tin tài khoản mới',
      'admin.createDesc': 'Tạo tài khoản và chọn quyền truy cập cho người dùng.',
      'admin.minPasswordPlaceholder': 'Ít nhất 8 ký tự',
      'admin.createNote': 'Tài khoản mới được kích hoạt ngay. Mật khẩu được mã hoá dạng băm và không thể xem lại.',
      'admin.createSubmit': 'Tạo tài khoản',
      'admin.createBack': 'Về danh sách tài khoản',
      'admin.editTitle': 'Chỉnh sửa tài khoản',
      'admin.operationLabel': 'Thao tác',
      'admin.opUpdate': 'Đổi quyền / trạng thái',
      'admin.opResetPassword': 'Đặt lại mật khẩu',
      'admin.opRevokeSessions': 'Đăng xuất mọi phiên',
      'admin.opDelete': 'Xoá tài khoản',
      'admin.statusLabel': 'Trạng thái',
      'admin.statusActive': 'Hoạt động',
      'admin.statusDisabled': 'Đã khoá',
      'admin.newPasswordLabel': 'Mật khẩu mới',
      'admin.deleteConfirmLabel': 'Nhập lại tên tài khoản để xác nhận xoá',
      'admin.deleteWarning': 'Tài khoản sẽ bị xoá và không thể đăng nhập. Lịch sử token và nhật ký quản trị được giữ lại.',
      'admin.editWarning': 'Đổi quyền, khoá tài khoản hoặc đặt lại mật khẩu sẽ thu hồi các phiên đăng nhập hiện có. Mật khẩu cũ không được hiển thị.',
      'admin.auditTitle': 'Nhật ký quản trị',
      'admin.auditDesc': '50 thao tác gần nhất. Không lưu mật khẩu trong nhật ký.',
      'admin.colTime': 'Thời gian',
      'admin.colAdmin': 'Admin',
      'admin.colOperation': 'Thao tác',

      'admin.pageOverviewTitle': 'Tổng quan ứng dụng',
      'admin.pageOverviewDesc': 'Các số liệu tổng hợp về tài khoản và sử dụng AI.',
      'admin.pageAnalyticsTitle': 'Sử dụng AI',
      'admin.pageAnalyticsDesc': 'Theo dõi token và phân bổ sử dụng theo tài khoản.',
      'admin.pageUsersTitle': 'Quản lý tài khoản',
      'admin.pageUsersDesc': 'Tìm kiếm, đổi quyền, khoá tài khoản và đặt lại mật khẩu.',
      'admin.pageCreateTitle': 'Tạo tài khoản mới',
      'admin.pageCreateDesc': 'Cấp tài khoản Standard, Vip hoặc Admin cho người dùng.',
      'admin.pageSystemTitle': 'Hệ thống',
      'admin.pageSystemDesc': 'Kiểm tra trạng thái kết nối và cấu hình phân quyền.',
      'admin.pageAuditTitle': 'Nhật ký hoạt động',
      'admin.pageAuditDesc': 'Theo dõi các thao tác quản trị gần nhất.',

      'admin.actCreate': 'Tạo tài khoản',
      'admin.actUpdate': 'Đổi quyền / trạng thái',
      'admin.actResetPassword': 'Đặt lại mật khẩu',
      'admin.actRevokeSessions': 'Thu hồi phiên',
      'admin.actDelete': 'Xoá tài khoản',
      'admin.actSetDailyLimit': 'Đổi giới hạn lượt/ngày',

      'admin.chartEmptyTitle': 'Chưa có dữ liệu token AI',
      'admin.chartEmptyDesc': 'Biểu đồ sẽ xuất hiện khi có sử dụng AI thực tế được ghi nhận.',
      'admin.manageBtn': 'Quản lý',
      'admin.deleteBtn': 'Xoá',
      'admin.noMatchingUsers': 'Không có tài khoản phù hợp.',
      'admin.confirmDeleteBtn': 'Xác nhận xoá tài khoản',
      'admin.confirmSaveBtn': 'Xác nhận thay đổi',
      'admin.manageUserTitle': 'Quản lý: {username}',
      'admin.busySwitching': 'Đang lưu thay đổi, vui lòng chờ hoàn tất trước khi chuyển mục.',
      'admin.invalidLimit': 'Giới hạn phải là số nguyên từ 1 đến 10.000.',
      'admin.limitSaveError': 'Không thể lưu giới hạn.',
      'admin.limitUpdated': 'Đã cập nhật giới hạn thành {limit} lượt/ngày.',
      'admin.invalidAccountName': 'Nhập tên tài khoản hợp lệ, không bắt đầu bằng =, +, @ hoặc -.',
      'admin.confirmDeleteName': 'Nhập chính xác tên tài khoản để xác nhận xoá.',
      'admin.saveError': 'Không thể lưu thay đổi.',
      'admin.savedRevoked': 'Đã lưu. Vui lòng đăng nhập lại vì phiên của bạn đã được thu hồi.',
      'admin.deletedAccount': 'Đã xoá tài khoản.',
      'admin.savedChanges': 'Đã lưu thay đổi.',
      'admin.activeAccountsCount': '{count} đang hoạt động',
      'admin.tokenDetailSummary': 'Vào: {input} · Ra: {output} · {requests} yêu cầu',
      'admin.noUsageYet': 'Chưa ghi nhận sử dụng AI thực tế',
      'admin.noAuditYet': 'Chưa có thao tác quản trị.'
    },

    en: {
      // Common / Lang switch
      'lang.switchAria': 'Switch language (Vietnamese / English)',
      'common.cancel': 'Cancel',
      'common.saveChanges': 'Save changes',
      'common.saving': 'Saving…',
      'common.loading': 'Loading…',
      'common.notLoaded': 'Not loaded yet',
      'common.loadError': 'Unavailable',

      // Session restore & Auth
      'restore.aria': 'Restoring session',
      'restore.title': 'Chatbot AI',
      'restore.checking': 'Restoring your session…',
      'restore.retry': 'Retry',
      'restore.relogin': 'Sign in again',
      'restore.networkError': 'Unable to reach the server. Your session is still saved; please try again.',
      'restore.expired': 'Your session has expired. Please sign in again.',

      'auth.modeAria': 'Account mode',
      'auth.tabLogin': 'Sign in',
      'auth.tabRegister': 'Register',
      'auth.loginTitle': 'LOGIN PAGE',
      'auth.registerTitle': 'REGISTER',
      'auth.usernameLabel': 'Username',
      'auth.usernamePlaceholder': 'Username',
      'auth.passwordLabel': 'Password',
      'auth.passwordPlaceholder': 'Password',
      'auth.showPassword': 'Show',
      'auth.hidePassword': 'Hide',
      'auth.showPasswordAria': 'Show password',
      'auth.hidePasswordAria': 'Hide password',
      'auth.loginBtn': 'Sign in',
      'auth.loggingInBtn': 'Signing in…',
      'auth.verifyingBtn': 'Verifying…',
      'auth.discordIdLabel': 'Discord ID',
      'auth.discordIdPlaceholder': 'Discord ID (17–20 digits)',
      'auth.regPasswordPlaceholder': 'Password (at least 8 characters)',
      'auth.confirmPasswordLabel': 'Confirm password',
      'auth.confirmPasswordPlaceholder': 'Confirm password',
      'auth.registerNote': 'You must already be a member of the Discord server to register.',
      'auth.registerBtn': 'Register',
      'auth.registeringBtn': 'Verifying…',

      // Chat
      'chat.collapseSidebar': 'Collapse sidebar',
      'chat.closeSidebar': 'Close sidebar',
      'chat.openSidebar': 'Open navigation',
      'chat.newChat': 'New chat',
      'chat.recent': 'RECENT',
      'chat.historySync': 'Saved in browser (up to 4 MB)',
      'chat.dailyRequests': 'Daily requests',
      'chat.newConversation': 'New conversation',
      'chat.adminBtn': 'Admin',
      'chat.logoutAria': 'Log out',
      'chat.inputLabel': 'Write a message',
      'chat.inputPlaceholder': 'Ask anything, or dream up something new...',
      'chat.attachAria': 'Attachments are not available in preview',
      'chat.storageTitle': 'Browser chat storage limit: up to 4 MB',
      'chat.modelGroupFree': 'Free',
      'chat.modelGroupLocked': 'Paid (Locked)',
      'chat.modelAuto': 'Auto (Free)',
      'chat.modelLockedGpt': '🔒 gpt-oss-120b (Locked)',
      'chat.modelLockedGemini': '🔒 Gemini 2.5 Flash Lite (Locked)',
      'chat.modelLockedDeepseek': '🔒 DeepSeek V4 Flash 0731 (Locked)',
      'chat.sendAria': 'Send message',
      'chat.respondingAria': 'Bot is responding…',
      'chat.disclaimer': 'AI can make mistakes. Please double-check important information.',
      'chat.typingAria': 'Typing',
      'chat.copy': 'Copy',
      'chat.copied': 'Copied!',

      // Session choice modal
      'modal.newChatTitle': 'Clear previous conversation?',
      'modal.newChatDesc': 'Only 1 active conversation is kept (<strong id="session-choice-summary"></strong>). Delete the old chat to start a new one?',
      'modal.newChatConfirm': 'Clear & start new',
      'modal.newChatKeep': 'Keep existing',
      'modal.lowSpaceTitle': 'Chat storage almost full',
      'modal.lowSpaceDesc': 'Chat history is using <strong id="session-choice-summary"></strong> (less than 1 MB left). Continue with existing data or clear for a fresh start?',
      'modal.lowSpaceSummary': '{count} chats • {used}',
      'modal.lowSpaceNew': 'Start fresh',
      'modal.lowSpaceContinue': 'Keep existing',

      // App notifications & errors
      'msg.enterBoth': 'Please enter your username and password.',
      'msg.enterUsername': 'Please enter your username.',
      'msg.enterPassword': 'Please enter your password.',
      'msg.loginSlow': 'Still signing you in. Please wait a moment.',
      'msg.loginFailed': 'Unable to sign in. Please try again.',
      'msg.loginSuccess': 'Signed in successfully.',
      'msg.loginNoStorage': 'Signed in, but browser storage is blocked so your session cannot be saved.',
      'msg.loginConnectError': 'Unable to reach the sign-in service. Please try again.',
      'msg.invalidDiscordId': 'Discord ID must be 17 to 20 digits.',
      'msg.invalidUsername': 'Invalid username (cannot start with =, +, @, or -).',
      'msg.invalidPasswordLen': 'Password must be between 8 and 256 characters.',
      'msg.passwordMismatch': 'Passwords do not match.',
      'msg.registerFailed': 'Unable to register account. Please try again.',
      'msg.registerSuccess': 'Registration successful. You can sign in now.',
      'msg.registerUnavailable': 'Registration verification is temporarily unavailable. Please try again later.',
      'msg.botResponding': 'The bot is still replying. Please wait before sending another message.',
      'msg.botRespondingNewChat': 'The bot is still replying. Please wait before starting a new chat.',
      'msg.botRespondingEnter': 'The bot is still replying. You can keep typing, but cannot send yet.',
      'msg.quotaReached': 'You have used all {limit} daily requests for today. Please come back tomorrow.',
      'msg.storageFull': 'Reached the 4 MB browser storage limit. Please start a fresh chat to continue.',
      'msg.storageWriteError': 'Could not save chat history in your browser. Storage may be full or blocked.',
      'msg.storageReadError': 'Could not read saved chat history from your browser.',
      'msg.aiError': 'Could not get a response from OpenRouter.',
      'msg.emptyBotReply': '(The bot returned an empty response.)',
      'msg.logoutRemoteError': 'Signed out locally, but failed to revoke the server session.',
      'msg.adminLoadError': 'Please update the backend and run setupAdminSheets.',
      'msg.adminExpired': 'Your session expired or lacks admin permissions. Please sign in again.',
      'msg.adminConfirmed': 'Connection and admin permissions verified.',
      'msg.modelLocked': 'Paid models are locked. Only Auto (Free) is available.',
      'msg.modelSelected': 'Selected model: {label}',
      'msg.clearedChat': 'Cleared old history and started a new conversation.',
      'msg.cryptoUnsupported': 'Your browser does not support secure random ID generation.',

      // API / Views
      'api.missingUrl': 'Please configure the Google Apps Script Web App URL in js/config.js.',
      'api.timeout': 'The server took too long to respond (timeout). Please try again.',
      'api.network': 'Unable to reach the server. Check the Web App URL and access settings.',
      'views.initError': 'Unable to load the app interface. Please reload the page.',

      // Admin HTML & JS
      'admin.navAria': 'Admin navigation',
      'admin.workspaceTitle': 'Admin workspace',
      'admin.workspaceSub': 'Application management',
      'admin.navOverview': 'Overview',
      'admin.navAnalytics': 'AI Usage',
      'admin.navUsers': 'Manage users',
      'admin.navCreate': 'Create user',
      'admin.navSystem': 'System',
      'admin.navAudit': 'Activity log',
      'admin.sidebarFooter': 'Admin workspace',
      'admin.backChat': 'Back to chat',
      'admin.refreshBtn': 'Refresh data',
      'admin.summaryHeading': 'Usage summary',
      'admin.allTime': 'All time',
      'admin.allTimeShort': 'All time',
      'admin.statTotalUsers': 'Total accounts',
      'admin.statTokensUsed': 'AI tokens used',
      'admin.statInputTokens': 'Input tokens',
      'admin.statInputSub': 'Prompts sent to AI models',
      'admin.statOutputTokens': 'Output tokens',
      'admin.statOutputSub': 'Responses generated by AI',
      'admin.chartTokenTitle': 'AI token breakdown',
      'admin.chartTokenSub': 'Top 8 accounts by usage',
      'admin.legendInput': 'Input',
      'admin.legendOutput': 'Output',
      'admin.chartRoleTitle': 'User roles',
      'admin.chartRoleSub': 'Distribution by role',
      'admin.accountsUnit': 'accounts',
      'admin.systemStatusTitle': 'System status',
      'admin.loginApiLabel': 'Auth API',
      'admin.apiUnchecked': 'Not checked',
      'admin.apiChecking': 'Checking…',
      'admin.apiConnected': 'Connected',
      'admin.apiDisconnected': 'Disconnected',
      'admin.lastCheckedLabel': 'Last checked',
      'admin.aiServiceLabel': 'AI Service',
      'admin.storageLabel': 'Account storage',
      'admin.rolesQuotaTitle': 'Roles & Daily Quota',
      'admin.rolesQuotaDesc': '<strong>Standard</strong> — standard user account.<br><strong>Vip</strong> — elevated user tier.<br><strong>Admin</strong> — manage users and view analytics.',
      'admin.usageNote': 'Tokens are recorded only from real AI provider responses, never from demo messages.',
      'admin.dailyLimitLabel': 'Daily request limit per user',
      'admin.saveLimitBtn': 'Save limit',
      'admin.userListTitle': 'Accounts',
      'admin.searchAccount': 'Search user',
      'admin.roleLabel': 'Role',
      'admin.roleAll': 'All',
      'admin.colAccount': 'Account',
      'admin.colRole': 'Role',
      'admin.colStatus': 'Status',
      'admin.colTokens': 'Input / Output tokens',
      'admin.colLastLogin': 'Last sign-in',
      'admin.colActions': 'Actions',
      'admin.createTitle': 'New account details',
      'admin.createDesc': 'Create an account and assign its access role.',
      'admin.minPasswordPlaceholder': 'At least 8 characters',
      'admin.createNote': 'New accounts are active immediately. Passwords are hashed and cannot be viewed later.',
      'admin.createSubmit': 'Create account',
      'admin.createBack': 'Back to accounts',
      'admin.editTitle': 'Edit account',
      'admin.operationLabel': 'Action',
      'admin.opUpdate': 'Change role / status',
      'admin.opResetPassword': 'Reset password',
      'admin.opRevokeSessions': 'Revoke all sessions',
      'admin.opDelete': 'Delete account',
      'admin.statusLabel': 'Status',
      'admin.statusActive': 'Active',
      'admin.statusDisabled': 'Disabled',
      'admin.newPasswordLabel': 'New password',
      'admin.deleteConfirmLabel': 'Re-enter username to confirm deletion',
      'admin.deleteWarning': 'The account will be deleted and unable to sign in. Token history and audit logs are preserved.',
      'admin.editWarning': 'Changing role, disabling the account, or resetting the password revokes all existing sessions. Existing passwords are never shown.',
      'admin.auditTitle': 'Audit log',
      'admin.auditDesc': 'Latest 50 actions. Passwords are never recorded.',
      'admin.colTime': 'Time',
      'admin.colAdmin': 'Admin',
      'admin.colOperation': 'Action',

      'admin.pageOverviewTitle': 'Application overview',
      'admin.pageOverviewDesc': 'Summary metrics for accounts and AI usage.',
      'admin.pageAnalyticsTitle': 'AI Usage',
      'admin.pageAnalyticsDesc': 'Track token consumption and usage per account.',
      'admin.pageUsersTitle': 'Manage users',
      'admin.pageUsersDesc': 'Search accounts, update roles/status, and reset passwords.',
      'admin.pageCreateTitle': 'Create user',
      'admin.pageCreateDesc': 'Provision a Standard, Vip, or Admin account.',
      'admin.pageSystemTitle': 'System',
      'admin.pageSystemDesc': 'Inspect service connectivity and role configuration.',
      'admin.pageAuditTitle': 'Activity log',
      'admin.pageAuditDesc': 'Review recent administrative actions.',

      'admin.actCreate': 'Create account',
      'admin.actUpdate': 'Update role / status',
      'admin.actResetPassword': 'Reset password',
      'admin.actRevokeSessions': 'Revoke sessions',
      'admin.actDelete': 'Delete account',
      'admin.actSetDailyLimit': 'Update daily limit',

      'admin.chartEmptyTitle': 'No AI token data yet',
      'admin.chartEmptyDesc': 'Charts will appear once real AI usage is recorded.',
      'admin.manageBtn': 'Manage',
      'admin.deleteBtn': 'Delete',
      'admin.noMatchingUsers': 'No matching accounts.',
      'admin.confirmDeleteBtn': 'Confirm deletion',
      'admin.confirmSaveBtn': 'Confirm changes',
      'admin.manageUserTitle': 'Manage: {username}',
      'admin.busySwitching': 'Saving changes, please wait before switching tabs.',
      'admin.invalidLimit': 'Limit must be a whole number between 1 and 10,000.',
      'admin.limitSaveError': 'Unable to save daily limit.',
      'admin.limitUpdated': 'Updated daily limit to {limit} requests/day.',
      'admin.invalidAccountName': 'Enter a valid username (cannot start with =, +, @, or -).',
      'admin.confirmDeleteName': 'Enter the exact username to confirm deletion.',
      'admin.saveError': 'Unable to save changes.',
      'admin.savedRevoked': 'Saved. Please sign in again because your session was revoked.',
      'admin.deletedAccount': 'Account deleted.',
      'admin.savedChanges': 'Changes saved.',
      'admin.activeAccountsCount': '{count} active',
      'admin.tokenDetailSummary': 'In: {input} · Out: {output} · {requests} requests',
      'admin.noUsageYet': 'No AI usage recorded yet',
      'admin.noAuditYet': 'No administrative actions yet.'
    }
  };

  const SERVER_CODE_MAP_EN = {
    TOO_MANY_ATTEMPTS: 'Too many failed attempts. Please try again in 5 minutes.',
    UNAUTHORIZED: 'Your session has expired. Please sign in again.',
    FORBIDDEN: 'Your session expired or you lack Admin permissions.',
    QUOTA_EXCEEDED: 'You have reached your daily request limit. Please come back tomorrow.',
    DUPLICATE_REQUEST: 'This request is already being processed. Please wait.',
    NOT_DISCORD_MEMBER: 'This Discord ID is not a member of the Discord server yet. Please join the Discord server first and try again.',
    DUPLICATE_USERNAME: 'This username already exists.',
    DUPLICATE_DISCORD_ID: 'This Discord ID has already been used to register an account.',
    PASSWORD_MISMATCH: 'Passwords do not match.',
    INVALID_PASSWORD: 'Invalid password (minimum 8 characters).',
    REGISTRATION_UNAVAILABLE: 'Registration verification is temporarily unavailable. Please try again later.',
    DISCORD_RATE_LIMITED: 'Discord verification is busy right now. Please try again in a few minutes.',
    INVALID_MODEL: 'Invalid AI model.',
    MODEL_LOCKED: 'Paid models are locked. Only Auto (Free) is available.',
    INVALID_MESSAGES: 'Invalid message list.',
    MISSING_API_KEY: 'OPENROUTER_API_KEY is not configured in Script Properties.',
    AI_AUTH_ERROR: 'OPENROUTER_API_KEY is invalid or rejected.',
    AI_PAYMENT_REQUIRED: 'Insufficient OpenRouter balance.',
    AI_RATE_LIMITED: 'OpenRouter is rate-limiting free models right now. Please wait a few seconds and retry.'
  };

  function readSavedLang() {
    try {
      const saved = typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null;
      return saved === 'en' ? 'en' : 'vi';
    } catch (error) {
      return 'vi';
    }
  }

  let currentLang = readSavedLang();

  function formatTemplate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
    });
  }

  function t(key, vars, fallback) {
    const table = DICT[currentLang] || DICT.vi;
    const raw = Object.prototype.hasOwnProperty.call(table, key)
      ? table[key]
      : (Object.prototype.hasOwnProperty.call(DICT.vi, key) ? DICT.vi[key] : (fallback || key));
    return formatTemplate(raw, vars);
  }

  function translateServerResult(result, fallbackKey) {
    if (currentLang === 'en' && result && result.code) {
      if (result.code === 'QUOTA_EXCEEDED' && Number(result.dailyLimit) > 0) {
        return t('msg.quotaReached', { limit: result.dailyLimit });
      }
      if (Object.prototype.hasOwnProperty.call(SERVER_CODE_MAP_EN, result.code)) {
        return SERVER_CODE_MAP_EN[result.code];
      }
    }
    return (result && result.message) || t(fallbackKey || 'msg.loginFailed');
  }

  function updateLangToggleButtons() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const buttons = document.querySelectorAll('[data-lang-toggle]');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.setAttribute('aria-label', t('lang.switchAria'));
      btn.setAttribute('data-current-lang', currentLang);
      const opts = btn.querySelectorAll('[data-lang-opt]');
      Array.prototype.forEach.call(opts, function (opt) {
        opt.classList.toggle('is-active', opt.getAttribute('data-lang-opt') === currentLang);
      });
    });
  }

  function apply(rootNode) {
    if (typeof document === 'undefined') return;
    if (document.documentElement) {
      document.documentElement.lang = currentLang;
    }
    const scope = rootNode && typeof rootNode.querySelectorAll === 'function' ? rootNode : document;
    if (typeof scope.querySelectorAll === 'function') {
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (el) {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-html]'), function (el) {
        const key = el.getAttribute('data-i18n-html');
        if (key) el.innerHTML = t(key);
      });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-placeholder]'), function (el) {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.setAttribute('placeholder', t(key));
      });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-aria-label]'), function (el) {
        const key = el.getAttribute('data-i18n-aria-label');
        if (key) el.setAttribute('aria-label', t(key));
      });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-title]'), function (el) {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.setAttribute('title', t(key));
      });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-label]'), function (el) {
        const key = el.getAttribute('data-i18n-label');
        if (key) el.setAttribute('label', t(key));
      });
    }
    updateLangToggleButtons();
  }

  function setLang(lang) {
    const next = lang === 'en' ? 'en' : 'vi';
    currentLang = next;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch (error) {}
    apply();
    listeners.forEach(function (fn) {
      try { fn(next); } catch (error) {}
    });
  }

  function toggleLang() {
    setLang(currentLang === 'vi' ? 'en' : 'vi');
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString(currentLang === 'en' ? 'en-US' : 'vi-VN');
  }

  function formatDate(value) {
    if (!value || isNaN(Date.parse(value))) return '—';
    return new Date(value).toLocaleString(currentLang === 'en' ? 'en-US' : 'vi-VN');
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (event) {
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-lang-toggle]')
        : null;
      if (target) {
        event.preventDefault();
        toggleLang();
      }
    });
  }

  window.appI18n = Object.freeze({
    DICT: DICT,
    getLang: function () { return currentLang; },
    setLang: setLang,
    toggleLang: toggleLang,
    t: t,
    translateServerResult: translateServerResult,
    apply: apply,
    onChange: onChange,
    formatNumber: formatNumber,
    formatDate: formatDate
  });
})();
