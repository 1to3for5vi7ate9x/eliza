import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { elizaLogger, IAgentRuntime } from '@elizaos/core';
import { NewMessage } from 'telegram/events';
import { Dialog } from 'telegram/tl/custom/dialog';
import input from 'input';
import { MessageManager } from './messageManager';
import { MarketingManager } from './marketingManager';
import { Message } from 'telegram/tl/custom/message';

export class TelegramUserClient {
    private client: TelegramClient;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private marketingManager: MarketingManager;
    private allowedGroups: Set<string>;
    private stringSession: StringSession;
    private sessionString: string = '';

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log('📱 Constructing new TelegramUserClient...');
        this.runtime = runtime;

        const apiId = parseInt(runtime.getSetting('TELEGRAM_API_ID'), 10);
        const apiHash = runtime.getSetting('TELEGRAM_API_HASH');
        const allowedGroupsStr = runtime.getSetting('TELEGRAM_ALLOWED_GROUPS');
        const savedSession = runtime.getSetting('TELEGRAM_SESSION');

        elizaLogger.log('Config:', { apiId, allowedGroups: allowedGroupsStr });

        if (!apiId || !apiHash) {
            throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment');
        }

        // Initialize allowed groups from names - empty string or undefined means no groups allowed
        this.allowedGroups = new Set(
            allowedGroupsStr?.trim() 
                ? allowedGroupsStr.split(',').map(name => name.trim())
                : []
        );
        elizaLogger.log('Initialized allowed groups:', Array.from(this.allowedGroups));
        if (this.allowedGroups.size === 0) {
            elizaLogger.warn('⚠️ No allowed groups specified - bot will not respond to any messages');
        }

        // Initialize session with saved session string if available
        this.stringSession = new StringSession(savedSession || '');
        this.client = new TelegramClient(this.stringSession, apiId, apiHash, {
            connectionRetries: 5,
            useWSS: true,
            requestRetries: 5,
            timeout: 30000,
            autoReconnect: true,
            floodSleepThreshold: 60,
            deviceModel: "Eliza Client",
            systemVersion: "1.0.0",
            appVersion: "1.0.0",
            langCode: "en",
            systemLangCode: "en"
        });

        elizaLogger.log('✅ TelegramUserClient constructor completed');
    }

    async start(): Promise<void> {
        try {
            elizaLogger.log('🚀 Starting Telegram client...');
            await this.initializeClient();

            // Initialize message manager with client
            this.messageManager = new MessageManager(this.runtime, this.client);
            
            await this.setupMessageHandlers();
            await this.messageManager.startMarketing(); // Start marketing functionality
            this.setupShutdownHandlers();
            
            // Set up connection monitoring
            setInterval(async () => {
                try {
                    await this.ensureConnection();
                } catch (error) {
                    elizaLogger.error('Failed to maintain connection:', error);
                }
            }, 60000);

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

            // Save the session string
            this.sessionString = this.client.session.save() as string;
            
            // Log the session string and instructions
            elizaLogger.info('🔑 Your Telegram session string has been generated.');
            elizaLogger.info('To avoid re-authentication, add this to your .env file:');
            elizaLogger.info('TELEGRAM_SESSION=' + this.sessionString);
            
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
                    const chatId = message?.chatId?.toString();
                    const messageText = message?.message || '';
                    const senderId = message?.senderId?.toString() || '';

                    elizaLogger.log('📨 Received message event:', {
                        chatId,
                        text: messageText,
                        fromId: senderId,
                        timestamp: new Date().toISOString()
                    });

                    // Skip if not from allowed groups
                    if (!chatId || !(await this.isAllowedGroup(chatId))) {
                        elizaLogger.log('⚠️ Message not from allowed group:', chatId);
                        return;
                    }

                    elizaLogger.log(`📝 Processing message: ${messageText}`);

                    try {
                        // Get sender info
                        const sender = await message.getSender();
                        const me = await this.client.getMe();

                        elizaLogger.log('👤 Message details:', {
                            sender: sender?.username,
                            me: me?.username,
                            text: messageText,
                            timestamp: new Date().toISOString()
                        });

                        // Process the message
                        const response = await this.messageManager.handleMessage({
                            text: messageText,
                            from: {
                                id: senderId,
                                username: sender?.username || '',
                            },
                            chat: {
                                id: chatId,
                                type: 'group',
                            },
                            replyTo: message.replyTo ? {
                                messageId: message.replyTo.id?.toString() || '',
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
                            text: messageText
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

    private async isAllowedGroup(chatId: string): Promise<boolean> {
        try {
            // If no groups specified, deny all access
            if (this.allowedGroups.size === 0) {
                elizaLogger.log('⚠️ No allowed groups configured - denying access');
                return false;
            }

            // Get chat information
            const chat = await this.client.getEntity(chatId);
            if (!chat) {
                elizaLogger.log(`⚠️ Could not find chat info for ID: ${chatId}`);
                return false;
            }

            // Check if the chat username matches any of the allowed group usernames
            const chatUsername = chat.username || '';
            const isAllowed = this.allowedGroups.has(chatUsername);
            elizaLogger.log(`Group check - Username: ${chatUsername}, Allowed: ${isAllowed}`);
            elizaLogger.log(`Allowed groups:`, Array.from(this.allowedGroups));
            return isAllowed;
        } catch (error) {
            elizaLogger.error('Error checking group permission:', error);
            return false;
        }
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
            elizaLogger.log('Stopping Telegram client...');
            await this.messageManager.stopMarketing();
            await this.client.disconnect();
            elizaLogger.success('✅ Telegram client stopped successfully');
        } catch (error) {
            elizaLogger.error('Error stopping Telegram client:', error);
            throw error;
        }
    }

    private async reconnectWithBackoff(attempt: number = 0): Promise<void> {
        const maxAttempts = 10;
        const baseDelay = 1000; // 1 second
        const maxDelay = 30000; // 30 seconds

        if (attempt >= maxAttempts) {
            throw new Error('Max reconnection attempts reached');
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        elizaLogger.log(`Reconnection attempt ${attempt + 1}/${maxAttempts} after ${delay}ms delay`);

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            await this.client.connect();
            elizaLogger.success('Reconnected successfully');
        } catch (error) {
            elizaLogger.error('Reconnection failed:', error);
            await this.reconnectWithBackoff(attempt + 1);
        }
    }

    private async ensureConnection(): Promise<void> {
        if (!this.client.connected) {
            elizaLogger.warn('Client disconnected, attempting to reconnect...');
            await this.reconnectWithBackoff();
        }
    }
}
