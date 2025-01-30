import { Client, Message, TextChannel } from 'discord.js-selfbot-v13';
import { elizaLogger, IAgentRuntime } from '@elizaos/core';
import { MessageManager } from './messageManager';

export class DiscordUserClient {
    private client: Client;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private allowedChannels: Set<string>;

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log('📱 Constructing new DiscordUserClient...');
        this.runtime = runtime;

        const token = runtime.getSetting('DISCORD_USER_TOKEN');

        elizaLogger.log('Config:', { token });

        if (!token) {
            throw new Error('DISCORD_USER_TOKEN must be set in environment');
        }

        this.allowedChannels = new Set();

        this.initializeAllowedChannels();

        elizaLogger.log('Initialized allowed channels:', Array.from(this.allowedChannels));
        if (this.allowedChannels.size === 0) {
            elizaLogger.warn('⚠️ No allowed channels specified - bot will not respond to any messages');
        }

        // Initialize Discord client with minimal configuration
        this.client = new Client({
            checkUpdate: false,
            autoRedeemNitro: false,
            syncStatus: false,
            patchVoice: false,
            ws: {
                properties: {
                    os: 'iOS',
                    browser: 'Discord iOS',
                    device: 'iPhone'
                }
            }
        });

        // Handle READY event to patch settings
        this.client.on('raw', (event: any) => {
            if (event.t === 'READY') {
                if (!event.d.user_settings) {
                    event.d.user_settings = {};
                }
                if (!event.d.user_settings.friend_source_flags) {
                    event.d.user_settings.friend_source_flags = { all: false };
                }
            }
        });

        // Initialize message manager
        this.messageManager = new MessageManager(runtime, this);

        elizaLogger.log('✅ DiscordUserClient constructor completed');
    }

    private initializeAllowedChannels(): void {
        const allowedChannelsStr = this.runtime.getSetting('DISCORD_ALLOWED_CHANNELS');
        if (allowedChannelsStr) {
            this.allowedChannels = new Set(
                allowedChannelsStr.split(',')
                    .map(c => c.trim().toLowerCase())
                    .filter(c => c) // Remove empty strings
            );
            elizaLogger.log('Initialized allowed channels:', Array.from(this.allowedChannels));
        } else {
            elizaLogger.warn('No allowed channels specified in DISCORD_ALLOWED_CHANNELS');
        }
    }

    async start(): Promise<void> {
        try {
            elizaLogger.log('Starting Discord client...');

            // Set up event handlers before login
            this.setupEventHandlers();

            // Get token without quotes if present
            const token = this.runtime.getSetting('DISCORD_USER_TOKEN')?.replace(/['"]/g, '');
            elizaLogger.log('Attempting to login...');

            // Add ready event handler
            this.client.on('ready', async () => {
                elizaLogger.log('Discord client ready!', {
                    username: this.client.user?.username,
                    id: this.client.user?.id,
                    isBot: this.client.user?.bot,
                    isConnected: this.client.isReady()
                });

                // Log all available channels
                const channels = await this.getChannels();
                elizaLogger.log('Available channels:', channels.map(c => ({
                    name: c.name,
                    id: c.id,
                    type: c.type,
                    permissions: {
                        sendMessages: c.permissionsFor(this.client.user!)?.has('SEND_MESSAGES'),
                        viewChannel: c.permissionsFor(this.client.user!)?.has('VIEW_CHANNEL')
                    }
                })));

                // Start marketing after client is ready
                try {
                    elizaLogger.log('Starting marketing functionality...');
                    await this.messageManager.startMarketing();
                    elizaLogger.log('Marketing functionality initialized');
                } catch (error) {
                    elizaLogger.error('Failed to start marketing:', error);
                }
            });

            // Add error event handler
            this.client.on('error', (error) => {
                elizaLogger.error('Discord client error:', error);
            });

            // Add debug event handler
            this.client.on('debug', (message) => {
                elizaLogger.log('Discord debug:', message);
            });

            // Login to Discord
            await this.client.login(token);

        } catch (error) {
            elizaLogger.error('Failed to start Discord client:', error);
            throw error;
        }
    }

    async getChannels(): Promise<TextChannel[]> {
        const channels: TextChannel[] = [];
        this.client.guilds.cache.forEach(guild => {
            guild.channels.cache.forEach(channel => {
                if (channel instanceof TextChannel) {
                    channels.push(channel);
                }
            });
        });
        return channels;
    }

    async stop(): Promise<void> {
        try {
            await this.client.destroy();
            elizaLogger.log('Discord client stopped');
        } catch (error) {
            elizaLogger.error('Error stopping Discord client:', error);
            throw error;
        }
    }

    private setupEventHandlers(): void {
        // Message event
        this.client.on('messageCreate', async (message) => {
            if (message.author.id === this.client.user?.id) return; // Ignore own messages
            if (!message.content) return; // Ignore messages without content

            const channelName = message.channel instanceof TextChannel ? message.channel.name : 'unknown';
            const isAllowed = this.allowedChannels.has(channelName.toLowerCase());

            elizaLogger.log(`Channel check - Name: ${channelName}, Allowed: ${isAllowed}`);

            if (!isAllowed) {
                elizaLogger.log(`⚠️ Message not from allowed channel: ${channelName}`);
                return;
            }

            // Log received message
            elizaLogger.log('📨 Received message event:', {
                channelName,
                text: message.content,
                fromId: message.author.id,
                timestamp: message.createdAt.toISOString()
            });

            try {
                const response = await this.messageManager.handleMessage(message);

                if (response?.text) {
                    await message.channel.send(response.text);
                } else {
                    elizaLogger.log('ℹ️ No response to send');
                }
            } catch (error) {
                elizaLogger.error('Error handling message:', error);
            }
        });
    }

    async getChannelById(channelId: string): Promise<TextChannel | null> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (channel && channel.isText()) {
                return channel as TextChannel;
            }
            return null;
        } catch (error) {
            elizaLogger.error('Error getting channel by ID:', {
                error: error instanceof Error ? error.message : String(error),
                channelId
            });
            return null;
        }
    }

    async sendMessage(channelId: string, options: { message: string }): Promise<void> {
        const channel = await this.getChannelById(channelId);
        if (!channel) {
            throw new Error(`Could not find channel with ID: ${channelId}`);
        }

        elizaLogger.log('Attempting to send message:', {
            channelName: channel.name,
            channelId: channel.id,
            messageLength: options.message.length,
            isClientReady: this.client.isReady(),
            permissions: {
                sendMessages: channel.permissionsFor(this.client.user!)?.has('SEND_MESSAGES'),
                viewChannel: channel.permissionsFor(this.client.user!)?.has('VIEW_CHANNEL')
            }
        });

        try {
            const sent = await channel.send(options.message);
            elizaLogger.log('Message sent successfully:', {
                messageId: sent.id,
                channelName: channel.name,
                timestamp: sent.createdTimestamp
            });
        } catch (error) {
            elizaLogger.error('Failed to send message:', {
                error: error instanceof Error ? error.message : String(error),
                channelId,
                channelName: channel.name,
                stack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }
    }

    async setTyping(channelId: string, options: { typing?: boolean } = {}): Promise<void> {
        const channel = await this.getChannelById(channelId);
        if (!channel) {
            throw new Error(`Could not find channel with ID: ${channelId}`);
        }

        if (options.typing !== false) {
            await channel.sendTyping();
        }
    }

    public getAllowedChannels(): Set<string> {
        return this.allowedChannels;
    }

    public getUserId(): string | undefined {
        return this.client.user?.id;
    }

    public getClient(): Client {
        return this.client;
    }
}
