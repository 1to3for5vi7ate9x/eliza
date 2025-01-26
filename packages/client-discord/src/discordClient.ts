import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { elizaLogger, IAgentRuntime } from '@elizaos/core';
import { MessageManager } from './messageManager';

export class DiscordClient {
    private client: Client;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private allowedChannels: Set<string>;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private readonly MAX_RECONNECT_ATTEMPTS: number = 10;
    private readonly RECONNECT_DELAY: number = 5000;
    private reconnectTimeout?: NodeJS.Timeout;

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log("📱 Constructing new DiscordClient...");
        this.runtime = runtime;
        this.messageManager = new MessageManager(this.runtime);

        const token = runtime.getSetting('DISCORD_BOT_TOKEN');
        const allowedChannelsStr = runtime.getSetting('DISCORD_ALLOWED_CHANNELS');

        elizaLogger.log('Config:', { allowedChannels: allowedChannelsStr });

        if (!token) {
            throw new Error('DISCORD_BOT_TOKEN must be set in environment');
        }

        // Initialize allowed channels
        this.allowedChannels = new Set(
            allowedChannelsStr?.trim()
                ? allowedChannelsStr.split(',').map(name => name.trim())
                : []
        );

        elizaLogger.log('Initialized allowed channels:', Array.from(this.allowedChannels));
        if (this.allowedChannels.size === 0) {
            elizaLogger.warn('⚠️ No allowed channels specified - bot will not respond to any messages');
        }

        // Initialize Discord client with necessary intents
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ]
        });

        elizaLogger.log('✅ DiscordClient constructor completed');
    }

    async start(): Promise<void> {
        try {
            elizaLogger.log('Starting Discord client...');
            
            // Set up message handler
            this.client.on('messageCreate', async (message: Message) => {
                // Ignore bot messages
                if (message.author.bot) return;

                // Check if channel is allowed
                if (message.channel instanceof TextChannel) {
                    const channelName = message.channel.name;
                    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(channelName)) {
                        return;
                    }
                }

                try {
                    const response = await this.messageManager.handleMessage({
                        text: message.content,
                        from: {
                            id: message.author.id,
                            username: message.author.username
                        },
                        chat: {
                            id: message.channel.id,
                            type: message.channel instanceof TextChannel ? 'text' : 'dm'
                        },
                        replyTo: message.reference ? {
                            messageId: message.reference.messageId!,
                            userId: message.reference.messageId! // This would need to be fetched if needed
                        } : undefined
                    });

                    if (response) {
                        await message.reply(response.toString());
                    }
                } catch (error) {
                    elizaLogger.error('Error handling message:', error);
                    await message.reply('Sorry, I encountered an error processing your message.');
                }
            });

            // Login to Discord
            await this.client.login(this.runtime.getSetting('DISCORD_BOT_TOKEN'));
            this.isConnected = true;
            elizaLogger.log('✅ Discord client started successfully');
        } catch (error) {
            elizaLogger.error('Failed to start Discord client:', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        try {
            elizaLogger.log('Stopping Discord client...');
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
            }
            await this.client.destroy();
            this.isConnected = false;
            elizaLogger.log('✅ Discord client stopped successfully');
        } catch (error) {
            elizaLogger.error('Error stopping Discord client:', error);
            throw error;
        }
    }
}
