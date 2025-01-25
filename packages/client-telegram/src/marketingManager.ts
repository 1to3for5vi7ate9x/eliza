import { elizaLogger, IAgentRuntime, generateMessageResponse, stringToUuid } from '@elizaos/core';
import { TelegramClient } from 'telegram';
import { Dialog } from 'telegram/tl/custom/dialog';
import { Message } from 'telegram/tl/custom/message';

export class MarketingManager {
    private client: TelegramClient;
    private runtime: IAgentRuntime;
    private targetGroups: Set<string>;
    private messageIntervals: Map<string, NodeJS.Timeout> = new Map();
    private lastMessageTimes: Map<string, number> = new Map();
    private readonly MIN_INTERVAL = 1.5 * 60 * 1000; // 1.5 minutes
    private readonly MAX_INTERVAL = 2.5 * 60 * 1000; // 2.5 minutes
    private readonly MAX_MESSAGES_PER_GROUP = 96; // Max messages per group per day

    constructor(client: TelegramClient, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.targetGroups = new Set();
    }

    async start(): Promise<void> {
        try {
            // Check if model provider is initialized
            if (!this.runtime?.modelProvider) {
                elizaLogger.error('Model provider not initialized');
                throw new Error('Model provider not initialized');
            }

            // Use existing TELEGRAM_ALLOWED_GROUPS setting
            const allowedGroupsStr = this.runtime.getSetting('TELEGRAM_ALLOWED_GROUPS');
            if (allowedGroupsStr) {
                this.targetGroups = new Set(allowedGroupsStr.split(',').map(g => g.trim()));
            }

            // Initialize marketing for each group
            await this.initializeGroupMarketing();

            elizaLogger.log('✅ Marketing manager started successfully');
            elizaLogger.log('📢 Marketing in groups:', Array.from(this.targetGroups));
        } catch (error) {
            elizaLogger.error('Failed to start marketing manager:', error);
            throw error;
        }
    }

    private async initializeGroupMarketing(): Promise<void> {
        try {
            // Get all dialogs (chats/groups)
            const dialogs = await this.client.getDialogs();

            for (const dialog of dialogs) {
                const groupName = dialog.title || dialog.name || '';
                if (this.targetGroups.has(groupName)) {
                    // Schedule random messages for this group
                    this.scheduleNextMessage(dialog);
                    elizaLogger.log(`📅 Scheduled marketing for group: ${groupName}`);
                }
            }
        } catch (error) {
            elizaLogger.error('Error initializing group marketing:', error);
        }
    }

    private scheduleNextMessage(dialog: Dialog): void {
        try {
            // Clear existing interval if any
            const existingInterval = this.messageIntervals.get(dialog.id.toString());
            if (existingInterval) {
                clearTimeout(existingInterval);
            }

            // Calculate random interval between MIN_INTERVAL and MAX_INTERVAL
            const interval = Math.floor(Math.random() * (this.MAX_INTERVAL - this.MIN_INTERVAL + 1) + this.MIN_INTERVAL);

            // Add small random variation to make it look more natural
            const jitter = Math.floor(Math.random() * 60000); // ±30 seconds
            const finalInterval = interval + jitter;

            // Schedule next message
            const timeout = setTimeout(async () => {
                try {
                    await this.sendMarketingMessage(dialog);
                } catch (error) {
                    elizaLogger.error('Error in scheduled message:', error);
                } finally {
                    // Always schedule next message, even if this one failed
                    this.scheduleNextMessage(dialog);
                }
            }, finalInterval);

            this.messageIntervals.set(dialog.id.toString(), timeout);
            elizaLogger.log(`📅 Scheduled next message for ${dialog.title} in ${Math.floor(finalInterval/1000/60)} minutes`);
        } catch (error) {
            elizaLogger.error('Error scheduling next message:', error);
            // Retry scheduling after a delay
            setTimeout(() => this.scheduleNextMessage(dialog), 60000);
        }
    }

    private async sendMarketingMessage(dialog: Dialog): Promise<void> {
        const maxRetries = 3;
        const retryDelay = 5000; // 5 seconds
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const isLastAttempt = attempt === maxRetries - 1;
            try {
                // Check if model provider is available
                if (!this.runtime?.modelProvider) {
                    throw new Error('Model provider not available');
                }

                const groupId = dialog.id.toString();
                const now = Date.now();

                // Check if we've exceeded max messages per day for this group
                const messageCount = await this.getMessageCountToday(dialog);
                if (messageCount >= this.MAX_MESSAGES_PER_GROUP) {
                    elizaLogger.log(`⚠️ Max messages reached for group: ${dialog.title}`);
                    return;
                }

                // Add random delay before sending to appear more natural
                const randomDelay = Math.floor(Math.random() * 10000); // 0-10 seconds
                await new Promise(resolve => setTimeout(resolve, randomDelay));

                // Generate marketing message using character profile
                const memory = {
                    id: stringToUuid(`marketing-${Date.now()}`),
                    timestamp: Date.now(),
                    type: 'marketing',
                    content: {
                        text: 'Generate a marketing message to promote our services',
                        type: 'text'
                    },
                    metadata: {
                        platform: 'telegram',
                        channelId: groupId,
                        messageType: 'marketing',
                        attempt: attempt + 1
                    },
                    roomId: stringToUuid(`${groupId}-${this.runtime.agentId}`),
                    agentId: this.runtime.agentId,
                    userId: stringToUuid(this.client.session.userId?.toString() || 'system')
                };

                // Create state with character information for marketing
                const state = {
                    character: {
                        name: this.runtime.character?.name || 'Agent',
                        description: this.runtime.character?.description || '',
                        style: this.runtime.character?.style || {},
                        topics: this.runtime.character?.topics || [],
                        knowledge: this.runtime.character?.knowledge || [],
                        system: this.runtime.character?.system || ''
                    },
                    prompt: {
                        text: 'Generate an engaging marketing message that promotes our services while staying true to the character\'s style and personality.',
                        type: 'marketing'
                    }
                };

                const response = await generateMessageResponse(
                    this.runtime,
                    memory,
                    state.prompt.text,
                    state
                );

                if (response && response.text) {
                    // Simulate typing before sending
                    await this.client.sendAction(dialog.id, { action: 'typing' });
                    await new Promise(resolve => setTimeout(resolve, response.text.toString().length * 100));

                    await this.client.sendMessage(dialog.id, {
                        message: response.text.toString(),
                        parseMode: 'markdown'
                    });

                    this.lastMessageTimes.set(groupId, now);
                    elizaLogger.success(`✅ Sent marketing message to ${dialog.title}`);
                    return; // Success, exit retry loop
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const errorMessage = lastError.message;

                if (isLastAttempt) {
                    elizaLogger.error(`Failed to send marketing message to ${dialog.title} after ${maxRetries} attempts:`, {
                        error: errorMessage,
                        attempts: attempt + 1
                    });
                    throw lastError;
                } else {
                    elizaLogger.warn(`Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${retryDelay}ms:`, {
                        error: errorMessage,
                        group: dialog.title
                    });
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
    }

    private async getMessageCountToday(dialog: Dialog): Promise<number> {
        try {
            const messages = await this.client.getMessages(dialog, {
                limit: 100, // Reasonable limit to check
                fromUser: this.client.session.userId
            });

            // Count messages from today only
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            return messages.filter(msg => {
                const msgDate = new Date(msg.date * 1000);
                return msgDate >= today;
            }).length;
        } catch (error) {
            elizaLogger.error('Error getting message count:', error);
            return 0;
        }
    }

    stop(): void {
        // Clear all scheduled messages
        for (const [groupId, interval] of this.messageIntervals) {
            clearTimeout(interval);
            this.messageIntervals.delete(groupId);
        }
        elizaLogger.log('Marketing manager stopped');
    }
}
