# Discord history setup

## Deploy

1. In Apps Script Project Settings > Script Properties, save DISCORD_BOT_TOKEN and DISCORD_GUILD_ID. Never put the bot token in frontend files.
2. Add Discord.gs to the same project as Code.gs and Admin.gs. Replace Code.gs with the current local version (it adds the three Discord API actions). Keep Admin.gs.
3. Give the bot server permissions: Manage Channels, View Channels, Send Messages, Read Message History, and **Embed Links**. It does not need Administrator. Use a private server dedicated to the application.
4. Run setupDiscordStorage once from the Apps Script editor. It checks the token/server, stores the bot ID, creates DiscordChats/DiscordMessages tabs and adds a discordOwnerId column to Users. Authorize external requests if prompted.
5. Deploy > Manage deployments > Edit > New version > Deploy. Keep the same /exec URL.
6. Refresh the website and sign in. The sidebar displays synchronization status and a retry button.

## Behavior

- Each account receives a stable random owner ID. This differs from a session token and survives password resets.
- A category is created lazily for the first synchronized chat. Its name includes the username and an owner ID suffix.
- Each new chat gets one text channel. Empty New chat is reused on the website instead of creating unlimited blank channels.
- When a category reaches 50 child channels, a new numbered category is created. Server-wide channel/category limits still apply; no unlimited storage is promised.
- Categories/channels deny View Channel to everyone and explicitly allow the bot. Server administrators can still read history. Regular users access their own chat through the authenticated website.
- Both the user's text and the demo assistant reply are saved as readable bot embeds. This does not connect a real AI provider.
- Sheets contain ownership, channel mappings and sent-message IDs, not conversation content. Discord stores the content. Keep these sheets and the bot token private.
- Reads only import messages produced by this bot with the app's metadata. Arbitrary human messages added directly in Discord are not imported as app conversation messages.
- Messages are read in pages of 100, saved in bounded batches, and deduplicated using app message IDs. A message/Sheet write interrupted at exactly the wrong time can still cause a duplicate after Discord's nonce deduplication window expires.
- On login, existing local history is synchronized; cloud chat metadata is loaded and selected conversations are fetched. Local storage remains a fallback/cache and is not automatically pruned in this version.
- Removing an account prevents access but does not delete its Discord channels. A recreated username receives a different owner ID and cannot read old channels through the API. Local cached history is still keyed by username; clear that device's cache before reassigning a deleted username to another person.
- Discord rate limits show a retryable error. Never delete channels or change mappings manually if you need to retain access to that history.

## Verification

Run `node --test tests/admin-backend.test.cjs`. Discord API calls are mocked; this checks authentication, private-channel permission payloads, cross-account isolation, duplicate saves, paginated reads and rate-limit errors without sending real messages.

Bot online status is not required for this REST API integration. No Gateway connection or always-running computer is required.
