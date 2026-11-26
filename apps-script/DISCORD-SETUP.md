# Discord history setup (via Node.js Bridge)

## Deploy

1. Deploy the Node.js bridge in `server/` (see `server/DEPLOY.md`) with `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, and `DISCORD_BRIDGE_SECRET` set as host environment variables. Never put the bot token in frontend files or commit it to Git.
2. In Apps Script **Project Settings > Script Properties**, save:
   - `DISCORD_BRIDGE_URL`: your deployed Node.js bridge base URL (e.g. `https://your-bridge.example.com`, without trailing slash).
   - `DISCORD_BRIDGE_SECRET`: the same shared secret configured on the Node.js host.
   (You no longer need `DISCORD_BOT_TOKEN` or `DISCORD_GUILD_ID` in Apps Script Script Properties.)
3. Update `Discord.gs` in the same Apps Script project as `Code.gs` and `Admin.gs`.
4. Give the bot server permissions: Manage Channels, View Channels, Send Messages, Read Message History, and **Embed Links**. It does not need Administrator. Use a private server dedicated to the application.
5. Run `setupDiscordStorage()` once from the Apps Script editor. It verifies the Node.js bridge and Discord bot/server, stores `DISCORD_BOT_ID`, creates `DiscordChats`/`DiscordMessages` tabs, and adds a `discordOwnerId` column to `Users`. Authorize external requests if prompted.
6. Deploy > Manage deployments > Edit > New version > Deploy. Keep the same `/exec` URL in `js/config.js`.
7. Refresh the website and sign in. The sidebar displays synchronization status and a retry button.

## Verification

Run `node --test tests/admin-backend.test.cjs tests/discord-bridge.test.cjs` from the repository root. Discord API calls are mocked; no real Discord requests are sent.
