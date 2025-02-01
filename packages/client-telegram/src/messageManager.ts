import {
    Content,
    Memory,
    State,
    ModelClass,
    elizaLogger,
    ServiceType,
    composeRandomUser,
    composeContext,
    getEmbeddingZeroVector,
    stringToUuid,
    IAgentRuntime,
    IImageDescriptionService,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    UUID,
    Media
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { Message } from './types.ts';
import { cosineSimilarity, escapeMarkdown } from "./utils";
import {
    MESSAGE_CONSTANTS,
    TIMING_CONSTANTS,
    RESPONSE_CHANCES,
} from "./constants";
import { TelegramClient, Dialog } from 'telegram';

// Base templates that incorporate character's style and behavior
export const telegramMessageHandlerTemplate = `
# Character Context
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

# Character Style
{{style.all}}
{{style.chat}}
{{style.avoid}}

# Current Conversation Context
Previous messages:
{{context}}

# Current Question/Message
User {{username}} asks: {{currentMessage}}
` + messageCompletionFooter;

export const telegramShouldRespondTemplate = `
# Character Context
Name: {{agentName}}
Role: {{description}}
Topics: {{topics}}

# Character Style
{{style.all}}
{{style.chat}}
{{style.avoid}}

# Conversation State
Previous messages:
{{context}}

Current message from user {{username}}: {{currentMessage}}
` + shouldRespondFooter;

// Marketing template that uses character's own marketing instructions
export const telegramMarketingTemplate = `
Generate a marketing message for Telegram. Keep it super short and casual.

# Character Context
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

# Character Style
{{style.all}}
{{style.chat}}
{{style.avoid}}

# Marketing Instructions
{{style.marketing}}

# Task
Generate a casual message to share in the group chat.
` + messageCompletionFooter;

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

export interface Message {
    text: string;
    from: {
        id: string;
        username: string;
    };
    chat: {
        id: string;
        type: string;
    };
    replyTo?: {
        messageId: string;
        userId: string;
    };
}

export class MessageManager {
    private runtime: IAgentRuntime;
    private client: TelegramClient;
    private interestChats: {
        [key: string]: {
            lastMessageSent: number;
            messages: { userId: string; userName: string; content: Content }[];
            contextSimilarityThreshold?: number;
        };
    } = {};

    // Marketing-related fields
    private readonly MIN_MESSAGES_FOR_ACTIVE = 5;
    private readonly MIN_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly MAX_MARKETING_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours
    private readonly groupMessageCounts = new Map<string, number>();
    private readonly lastMarketingTimes = new Map<string, number>();
    private readonly isProcessingMarketing = new Map<string, boolean>();
    private marketingEnabled = false;
    private targetGroups = new Set<string>();

    constructor(runtime: IAgentRuntime, client: TelegramClient) {
        elizaLogger.log('Initializing MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    private normalizeGroupName(name: string): string {
        if (!name) return '';
        // Remove t.me/ prefix and any special characters
        return name.replace(/^t\.me\//, '').toLowerCase().trim();
    }

    async startMarketing(): Promise<void> {
        try {
            elizaLogger.log('🚀 Starting marketing initialization...');

            // Use existing TELEGRAM_ALLOWED_GROUPS setting
            const allowedGroupsStr = this.runtime.getSetting('TELEGRAM_ALLOWED_GROUPS');
            if (allowedGroupsStr) {
                this.targetGroups = new Set(
                    allowedGroupsStr.split(',')
                        .map(g => g.trim())
                        .map(g => this.normalizeGroupName(g))
                );
            }

            // Reset all counters on start
            this.groupMessageCounts.clear();
            this.lastMarketingTimes.clear();

            // Initialize marketing for each group
            await this.initializeGroupMarketing();
            this.marketingEnabled = true;

            elizaLogger.log('✅ Marketing functionality started successfully');
            elizaLogger.log('📢 Marketing in groups:', Array.from(this.targetGroups));
        } catch (error) {
            elizaLogger.error('Failed to start marketing:', error);
            throw error;
        }
    }

    async stopMarketing(): Promise<void> {
        elizaLogger.log('Stopping marketing functionality...');
        this.marketingEnabled = false;
        elizaLogger.success('✅ Marketing functionality stopped');
    }

    private async initializeGroupMarketing(): Promise<void> {
        try {
            elizaLogger.log('Fetching dialogs...');
            const dialogs = await this.client.getDialogs({});
            elizaLogger.log(`Found ${dialogs.length} dialogs`);

            for (const groupName of this.targetGroups) {
                try {
                    elizaLogger.log(`Looking for group: ${groupName}`);

                    const dialog = dialogs.find(d => {
                        const title = this.normalizeGroupName(d.entity?.title || '');
                        const username = this.normalizeGroupName(d.entity?.username || '');
                        return title === groupName || username === groupName;
                    });

                    if (dialog) {
                        elizaLogger.log(`Found group ${groupName} with ID: ${dialog.id}`);

                        // Initialize counters
                        const normalizedName = this.normalizeGroupName(dialog.entity?.title || dialog.entity?.username || '');
                        this.groupMessageCounts.set(normalizedName, 0);

                        // Schedule first marketing message with random delay
                        const delay = Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL) + this.MIN_MARKETING_INTERVAL);
                        setTimeout(() => this.sendMarketingMessage(dialog), delay);
                        elizaLogger.log(`📅 Scheduled first marketing message for ${groupName} in ${Math.floor(delay / 60000)} minutes`);
                    } else {
                        elizaLogger.warn(`Could not find group: ${groupName}`);
                    }
                } catch (error) {
                    elizaLogger.error(`Failed to initialize marketing for group ${groupName}:`, error);
                }
            }
        } catch (error) {
            elizaLogger.error('Failed to fetch dialogs:', error);
            throw error;
        }
    }

    async sendMarketingMessage(dialog: Dialog): Promise<void> {
        if (!dialog?.entity) {
            elizaLogger.warn('Invalid dialog object');
            return;
        }

        const groupTitle = dialog.entity.title || '';
        const groupUsername = dialog.entity.username || '';
        const normalizedTitle = this.normalizeGroupName(groupTitle);
        const normalizedUsername = this.normalizeGroupName(groupUsername);

        // Find the matching group name
        const groupKey = this.targetGroups.has(normalizedTitle) ? normalizedTitle :
                        this.targetGroups.has(normalizedUsername) ? normalizedUsername : null;

        if (!groupKey) {
            elizaLogger.warn(`Attempted to send marketing to non-target group: ${groupTitle || groupUsername}`);
            return;
        }

        try {
            const now = Date.now();
            const lastSent = this.lastMarketingTimes.get(groupKey) || 0;

            // Double check the interval
            if (now - lastSent < this.MIN_MARKETING_INTERVAL) {
                const timeLeft = Math.ceil((this.MIN_MARKETING_INTERVAL - (now - lastSent)) / (1000 * 60));
                elizaLogger.log(`Too soon to send marketing to ${groupKey}. ${timeLeft} minutes remaining.`);
                return;
            }

            // Generate and send the marketing message
            const message = await this.generateMarketingMessage(dialog);
            if (message) {
                elizaLogger.log(`📨 Sending marketing message to ${groupKey}: ${message}`);
                await this.client.sendMessage(dialog.entity, {
                    message,
                    parseMode: 'markdown'
                });
                elizaLogger.log(`✅ Successfully sent marketing message to ${groupKey}`);

                // Update last sent time
                this.lastMarketingTimes.set(groupKey, now);

                // Schedule next check after the minimum interval
                const nextCheck = this.MIN_MARKETING_INTERVAL + Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL));
                elizaLogger.log(`Next marketing check for ${groupKey} in ${Math.floor(nextCheck / (1000 * 60))} minutes`);
            }
        } catch (error) {
            elizaLogger.error('Error in marketing message flow:', {
                error: error instanceof Error ? error.message : String(error),
                groupKey,
                dialogId: dialog.id
            });
        }
    }

    public async handleMessage(message: Message): Promise<{ text: string } | null> {
        try {
            const chatId = message.chat.id.toString();
            const userId = message.from?.id.toString();

            // Skip messages from the bot itself
            if (userId === this.client.session.userId?.toString()) {
                return null;
            }

            // Get dialog to get proper group name
            const dialogs = await this.client.getDialogs({});
            const dialog = dialogs.find(d => d.id.toString() === chatId);

            if (!dialog?.entity) {
                elizaLogger.warn('Could not find dialog for chat:', chatId);
                return null;
            }

            const groupTitle = dialog.entity.title || '';
            const groupUsername = dialog.entity.username || '';
            const normalizedTitle = this.normalizeGroupName(groupTitle);
            const normalizedUsername = this.normalizeGroupName(groupUsername);

            // Check if this is an allowed group
            if (!this.targetGroups.has(normalizedTitle) && !this.targetGroups.has(normalizedUsername)) {
                elizaLogger.log(`Skipping message from non-target group: ${groupTitle || groupUsername}`);
                return null;
            }

            // Use the matching group name for tracking
            const groupKey = this.targetGroups.has(normalizedTitle) ? normalizedTitle : normalizedUsername;
            elizaLogger.log(`Processing message in allowed group: ${groupKey}`);

            // Acquire lock for message counting
            if (this.isProcessingMarketing.get(groupKey)) {
                elizaLogger.log(`Marketing in progress for ${groupKey}, skipping message count`);
                return null;
            }

            // Update message count
            const count = (this.groupMessageCounts.get(groupKey) || 0) + 1;
            elizaLogger.log(`Processing message in allowed group: ${groupKey} (message ${count}/${this.MIN_MESSAGES_FOR_ACTIVE})`);
            this.groupMessageCounts.set(groupKey, count);

            // Check if we should send marketing
            if (count >= this.MIN_MESSAGES_FOR_ACTIVE) {
                const lastSent = this.lastMarketingTimes.get(groupKey) || 0;
                const now = Date.now();
                const timeSinceLastMessage = now - lastSent;

                if (timeSinceLastMessage >= this.MIN_MARKETING_INTERVAL) {
                    elizaLogger.log(`Group ${groupKey} is active and marketing interval passed, sending marketing message`);

                    // Set lock before processing
                    this.isProcessingMarketing.set(groupKey, true);

                    try {
                        await this.sendMarketingMessage(dialog);
                        // Reset counter and update last sent time only after successful send
                        this.lastMarketingTimes.set(groupKey, now);
                        this.groupMessageCounts.set(groupKey, 0);
                    } catch (error) {
                        elizaLogger.error(`Failed to send marketing message to ${groupKey}:`, error);
                    } finally {
                        // Always release the lock
                        this.isProcessingMarketing.set(groupKey, false);
                    }
                } else {
                    const timeLeft = Math.ceil((this.MIN_MARKETING_INTERVAL - timeSinceLastMessage) / (1000 * 60));
                    elizaLogger.log(`Marketing interval not reached for ${groupKey}. ${timeLeft} minutes remaining.`);
                }
            }

            return null;

        } catch (error) {
            elizaLogger.error('❌ Error handling message:', {
                error: error instanceof Error ? error.message : String(error),
                message: message.text,
                chatId: message.chat.id
            });
            return null;
        }
    }

    private async getMarketingMessageCountToday(dialog: Dialog): Promise<number> {
        try {
            elizaLogger.log(`Getting message count for ${dialog.title}`);
            const messages = await this.client.getMessages(dialog, {
                limit: 4,
                fromUser: this.client.session.userId
            });
            elizaLogger.log(`Retrieved ${messages.length} messages for ${dialog.title}`);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const todayMessages = messages.filter(msg => {
                const msgDate = new Date(msg.date * 1000);
                return msgDate >= today;
            });

            elizaLogger.log(`Found ${todayMessages.length} messages from today for ${dialog.title}`);
            return todayMessages.length;
        } catch (error) {
            elizaLogger.error(`Failed to get message count for ${dialog.title}:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                dialogId: dialog.id,
                dialogTitle: dialog.title
            });
            return 0;
        }
    }

    private async generateMarketingMessage(dialog: Dialog): Promise<string | null> {
        try {
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
                    channelId: dialog.id.toString(),
                    messageType: 'marketing'
                },
                roomId: stringToUuid(`${dialog.id}-${this.runtime.agentId}`),
                agentId: this.runtime.agentId,
                userId: stringToUuid(this.client.session.userId?.toString() || 'system')
            };

            // Create state with character information
            const state = {
                character: this.runtime.character,
                agentName: this.runtime.character?.name || 'Agent',
                bio: this.runtime.character?.bio || [],
                style: this.runtime.character?.style || {},
                topics: this.runtime.character?.topics || [],
                knowledge: this.runtime.character?.knowledge || [],
                lore: this.runtime.character?.lore || '',
                system: this.runtime.character?.system || '',
                prompt: {
                    text: 'Generate a short marketing message',
                    type: 'marketing'
                }
            };

            elizaLogger.log(`Generating marketing message for ${dialog.title} with character:`, {
                name: state.agentName,
                hasStyle: !!state.style,
                hasTopics: !!state.topics?.length,
                hasKnowledge: !!state.knowledge?.length
            });

            // Use character's telegramMarketingTemplate if available
            const template = this.runtime.character?.templates?.telegramMarketingTemplate || telegramMarketingTemplate;
            elizaLogger.log('Using template:', template);

            const context = composeContext({
                state,
                template
            });
            elizaLogger.log('Composed context:', context);

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE
            });
            elizaLogger.log('Raw response:', response);

            // Parse JSON response if it's in JSON format
            let responseText: string;
            try {
                if (typeof response === 'string') {
                    elizaLogger.log('Processing string response');
                    const jsonMatch = response.match(/```json\s*({[\s\S]*?})\s*```/);
                    if (jsonMatch) {
                        elizaLogger.log('Found JSON in response:', jsonMatch[1]);
                        const jsonResponse = JSON.parse(jsonMatch[1]);
                        responseText = jsonResponse.text;
                        elizaLogger.log('Parsed JSON response text:', responseText);
                    } else {
                        elizaLogger.log('No JSON found, using raw response');
                        responseText = response;
                    }
                } else if (typeof response === 'object' && response.text) {
                    elizaLogger.log('Processing object response:', response);
                    responseText = String(response.text);
                } else {
                    elizaLogger.warn('Invalid response format:', response);
                    return null;
                }
            } catch (error) {
                elizaLogger.error('Error parsing response:', error);
                elizaLogger.error('Raw response that failed:', response);
                responseText = String(response);
            }

            elizaLogger.log('Final response text:', responseText);
            return responseText;
        } catch (error) {
            elizaLogger.error('Error generating marketing message:', error);
            elizaLogger.error('Full error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            return null;
        }
    }
}
