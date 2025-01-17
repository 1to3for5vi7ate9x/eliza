# Telegram Usage Instructions for Eliza 🤖

This guide will help you set up and run Eliza with Telegram integration.

## Prerequisites

Before starting, make sure you have:
- A Telegram account
- Access to [my.telegram.org/apps](https://my.telegram.org/apps)
- Node.js and pnpm installed

## Setup Steps

### 1. Get Telegram API Credentials

1. Visit [my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram account
3. Create a new application if you haven't already
4. Note down the following credentials:
   - API ID
   - API Hash
   - Phone Number (in international format, e.g., +1234567890)

### 2. Configure Environment Variables

Copy the following variables to your `.env` file and fill in your credentials:

```bash
# Telegram Configuration
TELEGRAM_API_ID=            # API ID from my.telegram.org/apps
TELEGRAM_API_HASH=          # API Hash from my.telegram.org/apps
TELEGRAM_PHONE_NUMBER=      # Your phone number in international format
TELEGRAM_ALLOWED_GROUPS=    # (Optional) Comma-separated list of group usernames (e.g., CryptoTalk,AIDiscussion)
TELEGRAM_SESSION=           # Will be auto-generated after first login
```

### 3. Configure Allowed Groups (Optional)

To restrict the bot to specific groups:
1. Add your bot to the desired Telegram groups
2. Set the `TELEGRAM_ALLOWED_GROUPS` variable with the group usernames:
   ```bash
   TELEGRAM_ALLOWED_GROUPS=CryptoTalk,AIDiscussion,BlockchainHub
   ```
3. The bot will only respond in these specified groups
4. Group usernames are case-sensitive and should match exactly as shown in the invite link (e.g., if the invite link is t.me/MyGroup, use "MyGroup")
5. Leave empty to allow the bot to respond in all groups

### 4. Start Eliza with CryptoAI Sage

Run the following command to start Eliza with the CryptoAI Sage character:

```bash
pnpm start --characters=characters/cryptoai_sage.character.json
```

### 5. First-Time Login

On the first run:
1. You'll be prompted to enter your phone number
2. Telegram will send you a verification code
3. Enter the verification code when prompted
4. The session string will be generated save it to .env file to avoid verification each time you run the character file

### 6. Subsequent Runs

After the initial setup, you can simply use the same start command:

```bash
pnpm start --characters=characters/cryptoai_sage.character.json
```

## Usage Tips

- The bot will only respond in groups listed in `TELEGRAM_ALLOWED_GROUPS`
- Group usernames must match exactly as they appear in the invite link (e.g., if the invite link is t.me/MyGroup, use "MyGroup")
- You can add or remove groups by updating the `TELEGRAM_ALLOWED_GROUPS` list
- If no groups are specified, the bot will not respond to any messages
- You can interact with the bot in both private chats and groups just make sure to mention them in .env
- Use the bot's commands to interact with the CryptoAI Sage character

## Troubleshooting

If you encounter any issues:
1. Ensure all environment variables are correctly set
2. Check that your API credentials are valid
3. Make sure your phone number is in the correct international format
4. If the session expires, delete the session string from `.env` and log in again

## Security Notes

- Keep your API ID and Hash secure
- Never share your session string
- Regularly review the allowed groups list
- Monitor bot activity in your Telegram account's security settings
