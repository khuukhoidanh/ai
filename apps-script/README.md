# Chatbot authentication and administration

The root index.html contains login, chat and admin views. Apps Script serves JSON only. Passwords are salted PBKDF2 hashes and are never returned to the browser.

## Update the deployment

1. Replace Code.gs in the spreadsheet-bound Apps Script project with this version.
2. Add a script file named Admin and paste Admin.gs into it. Both files are required.
3. Run setupAdminSheets() once. It preserves password hashes, maps legacy user roles to standard, and creates the additional columns/tabs.
4. Ensure your own row has role admin. Supported roles: standard, vip, admin (case-insensitive; displayed as Standard, Vip, Admin).
5. Deploy > Manage deployments > Edit > New version > Deploy. Execute as Me, access Anyone. Retain the existing /exec URL in js/config.js.
6. Reload index.html using Live Server/static hosting and sign in again. Open the admin button beside logout.

If organization policy prevents anonymous Web App access, this direct frontend connection needs another deployment environment or a proxy.

## First-time setup

Create a spreadsheet, open Extensions > Apps Script, upload both .gs files and run setupAdminSheets(). Create the first admin through an editor-only temporary helper calling createUser('owner', 'replace-with-a-long-unique-password', 'admin'). Run once, then delete the helper and password literal. Keep the spreadsheet private.

## Features

- List/search/filter accounts by Standard, Vip and Admin.
- Create accounts; change role; lock/unlock accounts; delete accounts with exact username confirmation.
- Set new passwords (8-256 characters); old passwords cannot be viewed.
- Revoke all sessions for an account.
- View all-time recorded AI input/output tokens, totals and per-account counts.
- View the latest 50 admin actions, excluding passwords.

Every admin request checks the session and current role on the server. Password/role/status changes and session revocation invalidate existing tokens. Admins cannot disable/demote themselves; the last active Admin is protected. Updating your own account requires signing in again.

Standard and Vip currently have the same chat behavior. Model restrictions and token quotas have not been defined or enforced. Deletion removes the Users row, invalidates access and retains Usage/Audit history. Admins cannot delete themselves or the last active administrator. Usage is attributed by username; recreating the same username includes its historical usage.

## Spreadsheet tabs

- Users: username, password, role, status, sessionVersion, createdAt, lastLogin. Blank status means active. Older accounts may lack creation/login timestamps.
- Usage: requestId, timestamp, username, model, inputTokens, outputTokens.
- Audit: timestamp, actor, action, target.

Do not reorder Usage/Audit columns. Users columns are addressed by name. Never write plaintext passwords into Users.

## AI usage integration

Chat is still a demo with no AI provider connection. Demo messages do not create token usage. The dashboard displays an empty state until actual records exist.

After connecting an AI provider on the server, call recordAiUsage_(username, model, inputTokens, outputTokens, providerRequestId) using authenticated identity and counts returned by the provider after successful requests. Do not accept these values from browser input. There is no public usage-recording endpoint.

Request IDs deduplicate retries: 1-256 characters, beginning with an alphanumeric character, containing only alphanumeric characters or underscore, dot, colon, slash, hyphen.

## API

POST JSON as text/plain;charset=utf-8 to /exec and follow redirects. Do not use no-cors, which prevents reading responses.

- login: username, password
- getSession: token
- logout: token
- adminDashboard: token
- adminManageUser: token, operation, username. Operations: create (password/role), update (role/status), resetPassword (password), revokeSessions, delete (confirmUsername matching the stored username exactly).

The browser stores only the session token in localStorage under chatbot.sessionToken. Passwords and cached roles are not persisted. On page load, getSession validates the saved token against the server before showing chat or admin controls. Logout and invalid sessions remove it; network errors keep it for a retry. Tokens expire after six hours or earlier on Apps Script cache eviction. Account recovery and distributed login throttling are not implemented. Spreadsheet reads aggregate all usage, so large histories will eventually require aggregation or a database.

## Tests

Run node --test tests/admin-backend.test.cjs from the repository root. Tests mock Apps Script services to verify authorization, migration, password reset, revocation, usage aggregation and password non-disclosure. Test the deployed Google environment separately.
