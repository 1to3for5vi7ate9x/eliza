# Quickstart Guide for Discord and Telegram Integration

This guide provides quick setup instructions for integrating Discord and Telegram with Eliza.

## ⚠️ Discord Setup

### Important Warning
```diff
- CAUTION: Using this on a user account is prohibited by the Discord TOS and can lead to the account block.
- Use at your own risk. We recommend using official bot accounts instead.
```

### Getting Discord User Token
1. Log into Discord in your web browser
2. Open Developer Console (F12 or Ctrl+Shift+I)
3. Paste and run the following code in the console:

```javascript
window.webpackChunkdiscord_app.push([
  [Math.random()],
  {},
  req => {
    if (!req.c) return;
    for (const m of Object.keys(req.c)
      .map(x => req.c[x].exports)
      .filter(x => x)) {
      if (m.default && m.default.getToken !== undefined) {
        return copy(m.default.getToken());
      }
      if (m.getToken !== undefined) {
        return copy(m.getToken());
      }
    }
  },
]);
window.webpackChunkdiscord_app.pop();
console.log('%cWorked!', 'font-size: 50px');
console.log(`%cYou now have your token in the clipboard!`, 'font-size: 16px');
```

4. The token will be copied to your clipboard
5. Add the token to your `.env` file:
```env
DISCORD_USER_TOKEN=your_token_here
DISCORD_ALLOWED_CHANNELS=channel1,channel2
```

## 🤖 Telegram Setup

### Creating Telegram Application
1. Visit [Telegram API Development Tools](https://my.telegram.org/apps)
2. Log in with your phone number
3. Create a new application
4. You will receive:
   - API ID (number)
   - API Hash (string)

### Environment Setup
Add the following to your `.env` file:
```env
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_ALLOWED_GROUPS=group1,group2
```

## Quick Implementation

### Discord Client
```typescript
import { DiscordUserClient } from '@eliza/client-discord';

const client = new DiscordUserClient(runtime);
await client.start();
```

### Telegram Client
```typescript
import { TelegramUserClient } from '@eliza/client-telegram';

const client = new TelegramUserClient(runtime);
await client.start();
```

## Character Configuration
Update your character configuration to specify which clients to use:

```json
{
  "name": "YourBot",
  "clients": ["discord", "telegram"],
  "modelProvider": "your_provider",
  "settings": {
    "secrets": {}
  }
}
```

## Marketing Features
Both clients support automated marketing with these defaults:
- Message Interval: 15-45 minutes
- Daily Limit: 96 messages per channel/group

Enable marketing:
```typescript
// Discord
await discordClient.messageManager.startMarketing();

// Telegram
await telegramClient.messageManager.startMarketing();
```

## Common Issues

### Discord
- Token Invalid: Regenerate token using the console script
- Rate Limits: Ensure you're not sending too many messages too quickly
- Channel Access: Verify the channels in DISCORD_ALLOWED_CHANNELS exist

### Telegram
- API ID/Hash Invalid: Double-check values on my.telegram.org
- Session Errors: Clear session data and restart
- Group Access: Ensure bot is member of groups in TELEGRAM_ALLOWED_GROUPS
