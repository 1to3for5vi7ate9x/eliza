import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { elizaLogger, IAgentRuntime } from '@elizaos/core';
import { NewMessage } from 'telegram/events';
import { Dialog } from 'telegram/tl/custom/dialog';
import input from 'input';
import { MessageManager } from './messageManager';
import { Message } from 'telegram/tl/custom/message';

export class TelegramUserClient {
    private client: TelegramClient;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private allowedGroups: Set<string>;
    private stringSession: StringSession;
    private sessionString: string = '';

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log('📱 Constructing new TelegramUserClient...');
        this.runtime = runtime;
        this.messageManager = new MessageManager(this.runtime);

        const apiId = parseInt(runtime.getSetting('TELEGRAM_API_ID'), 10);
        const apiHash = runtime.getSetting('TELEGRAM_API_HASH');
        const allowedGroupsStr = runtime.getSetting('TELEGRAM_ALLOWED_GROUPS');

        elizaLogger.log('Config:', { apiId, allowedGroups: allowedGroupsStr });

        if (!apiId || !apiHash) {
            throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment');
        }

        // Normalize group IDs by removing any minus signs
        this.allowedGroups = new Set(
            allowedGroupsStr?.split(',')
                .map(id => id.trim().replace(/^-/, '')) || []
        );
        elizaLogger.log('Initialized allowed groups:', Array.from(this.allowedGroups));

        this.stringSession = new StringSession('');
        this.client = new TelegramClient(this.stringSession, apiId, apiHash, {
            connectionRetries: 5,
        });

        elizaLogger.log('✅ TelegramUserClient constructor completed');
    }

    async start(): Promise<void> {
        try {
            elizaLogger.log('🚀 Starting Telegram client...');
            await this.initializeClient();
            await this.setupMessageHandlers();
            this.setupShutdownHandlers();
            elizaLogger.success('✨ Telegram client successfully started!');

            // Log successful connection
            const me = await this.client.getMe();
            elizaLogger.log('Connected as:', {
                username: me.username,
                firstName: me.firstName,
                id: me.id
            });

            // Log allowed groups
            elizaLogger.log('Monitoring groups:', Array.from(this.allowedGroups));
        } catch (error) {
            elizaLogger.error('Failed to start Telegram client:', error);
            throw error;
        }
    }

    private async initializeClient(): Promise<void> {
        try {
            await this.client.start({
                phoneNumber: async () => this.runtime.getSetting('TELEGRAM_PHONE_NUMBER'),
                password: async () => await input.text('Please enter your 2FA password: '),
                phoneCode: async () => await input.text('Please enter the code you received: '),
                onError: (err) => elizaLogger.error('Connection error:', err),
            });

            elizaLogger.success('✅ Successfully connected to Telegram!');

            // Save the session for future use
            this.sessionString = this.client.session.save() as string;
            elizaLogger.log('Session saved successfully');
        } catch (error) {
            elizaLogger.error('Failed to initialize Telegram client:', error);
            throw error;
        }
    }

    private async setupMessageHandlers(): Promise<void> {
        try {
            elizaLogger.log('Setting up message handlers...');

            this.client.addEventHandler(async (event: NewMessage.Event) => {
                try {
                    const message = event.message;
                    const chatId = message.chatId?.toString();

                    elizaLogger.log('📨 Received message event:', {
                        chatId,
                        text: message.message,
                        fromId: message.senderId?.toString(),
                        timestamp: new Date().toISOString()
                    });

                    // Skip if not from allowed groups
                    if (!chatId || !this.isAllowedGroup(chatId)) {
                        elizaLogger.log('⚠️ Message not from allowed group:', chatId);
                        return;
                    }

                    // Get the message text
                    const text = message.message || '';
                    elizaLogger.log(`📝 Processing message: ${text}`);

                    try {
                        // Get sender info
                        const sender = await message.getSender();
                        const me = await this.client.getMe();

                        elizaLogger.log('👤 Message details:', {
                            sender: sender?.username,
                            me: me.username,
                            text,
                            timestamp: new Date().toISOString()
                        });

                        // Process the message
                        const response = await this.messageManager.handleMessage({
                            text,
                            from: {
                                id: message.senderId?.toString() || '',
                                username: sender?.username || '',
                            },
                            chat: {
                                id: chatId,
                                type: 'group',
                            },
                            replyTo: message.replyTo ? {
                                messageId: message.replyTo.id.toString(),
                                userId: message.replyTo.senderId?.toString() || '',
                            } : undefined,
                        });

                        // Send the response
                        if (response && response.text) {
                            let messageText: string;

                            // Ensure we have a string
                            if (typeof response.text === 'object') {
                                // If it's an object with a text field, use that
                                messageText = response.text.text || JSON.stringify(response.text);
                            } else {
                                messageText = String(response.text);
                            }

                            elizaLogger.log('📤 Preparing to send response:', {
                                messageText,
                                chatId,
                                replyToMessage: message.id
                            });

                            try {
                                await this.client.sendMessage(message.chatId, {
                                    message: messageText,
                                    replyTo: message.id,
                                });
                                elizaLogger.success('✅ Response sent successfully');
                            } catch (sendError) {
                                elizaLogger.error('❌ Failed to send response:', {
                                    error: sendError instanceof Error ? sendError.message : 'Unknown error',
                                    stack: sendError instanceof Error ? sendError.stack : undefined,
                                    response: messageText,
                                    chatId
                                });
                            }
                        } else {
                            elizaLogger.log('ℹ️ No response to send');
                        }
                    } catch (processingError) {
                        elizaLogger.error('❌ Error processing message:', {
                            error: processingError instanceof Error ? processingError.message : 'Unknown error',
                            stack: processingError instanceof Error ? processingError.stack : undefined,
                            chatId,
                            text
                        });
                    }
                } catch (eventError) {
                    elizaLogger.error('❌ Critical error in event handler:', {
                        error: eventError instanceof Error ? eventError.message : 'Unknown error',
                        stack: eventError instanceof Error ? eventError.stack : undefined
                    });
                }
            }, new NewMessage({}));

            elizaLogger.log('✅ Message handlers set up successfully');
        } catch (error) {
            elizaLogger.error('Failed to set up message handlers:', error);
            throw error;
        }
    }

    private isAllowedGroup(chatId: string): boolean {
        // Remove the minus sign if present for comparison
        const normalizedChatId = chatId.replace(/^-/, '');
        const isAllowed = this.allowedGroups.size === 0 || this.allowedGroups.has(normalizedChatId);
        elizaLogger.log(`Group check - Raw: ${chatId}, Normalized: ${normalizedChatId}, Allowed: ${isAllowed}`);
        elizaLogger.log(`Allowed groups:`, Array.from(this.allowedGroups));
        return isAllowed;
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(`Received ${signal}, shutting down Telegram client...`);
            try {
                await this.stop();
                process.exit(0);
            } catch (error) {
                elizaLogger.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdownHandler('SIGINT'));
        process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
    }

    async stop(): Promise<void> {
        try {
            elizaLogger.log('Disconnecting from Telegram...');
            await this.client.disconnect();
            elizaLogger.success('✅ Successfully disconnected from Telegram');
        } catch (error) {
            elizaLogger.error('Error disconnecting from Telegram:', error);
            throw error;
        }
    }
}
