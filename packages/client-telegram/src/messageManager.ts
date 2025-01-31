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
    private targetGroups: Set<string> = new Set();
    private lastMarketingTimes: Map<string, number> = new Map();
    private groupMessageCounts: Map<string, number> = new Map(); // Track messages since last bot message
    private groupTimeReductions: Map<string, number> = new Map(); // Track accumulated time reductions
    private groupActivities: Map<string, { lastMarketingTime: number; recentMessages: { time: number; isUser: boolean }[]; lastDailyReset: number }> = new Map();

    // Constants for marketing timing and activity tracking
    private readonly MARKETING_CONSTANTS = {
        MIN_MARKETING_INTERVAL: 2 * 60 * 1000,    // 2 minutes for testing (normally 6 hours)
        REQUIRED_MESSAGES: 3,                     // Number of messages needed to consider group active
        MESSAGE_ACTIVITY_WINDOW: 5 * 60 * 1000,   // 5 minute window to count messages
        MAX_MESSAGES_PER_DAY: 4                   // Maximum marketing messages per day
    };

    // Base timing constants
    private readonly MIN_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly MAX_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly BASE_WAIT_TIME = 6 * 60 * 60 * 1000;        // 6 hours
    private readonly MIN_MESSAGES_BEFORE_REPLY = 2;
    private readonly TIME_REDUCTION_PER_MESSAGE = 30 * 60 * 1000; // 30 minutes
    private readonly MIN_WAIT_TIME = 4 * 60 * 60 * 1000;         // 4 hours
    private readonly MAX_MARKETING_MESSAGES_PER_GROUP = 4;        // 4 messages per day max (24/6)
    private marketingEnabled: boolean = false;

    // Add rate limiting constants
    private readonly MESSAGE_CONSTANTS = {
        MIN_MESSAGE_INTERVAL: 5000, // 5 seconds between responses
        MESSAGE_BATCH_WINDOW: 10000, // 10 second window to collect messages
        MAX_BATCH_SIZE: 5 // Maximum messages to batch together
    };

    private lastResponseTimes: Map<string, number> = new Map();
    private messageBatches: Map<string, {
        messages: { text: string; timestamp: number }[];
        batchTimeout?: NodeJS.Timeout;
    }> = new Map();

    constructor(runtime: IAgentRuntime, client: TelegramClient) {
        elizaLogger.log('Initializing MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    async startMarketing(): Promise<void> {
        try {
            // Use existing TELEGRAM_ALLOWED_GROUPS setting
            const allowedGroupsStr = this.runtime.getSetting('TELEGRAM_ALLOWED_GROUPS');
            if (allowedGroupsStr) {
                // Normalize group names by removing t.me/ prefix
                this.targetGroups = new Set(
                    allowedGroupsStr.split(',')
                        .map(g => g.trim())
                        .map(g => this.normalizeGroupName(g))
                );
            }

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

    private normalizeGroupName(name: string): string {
        // Remove t.me/ prefix if present
        return name.replace(/^t\.me\//, '');
    }

    private async initializeGroupMarketing(): Promise<void> {
        for (const groupName of this.targetGroups) {
            try {
                elizaLogger.log(`Looking for group: ${groupName}`);
                const dialogs = await this.client.getDialogs({});
                elizaLogger.log(`Found ${dialogs.length} dialogs`);
                
                const dialog = dialogs.find(d => {
                    const title = this.normalizeGroupName(d.title || '');
                    const name = this.normalizeGroupName(d.name || '');
                    const matchesTitle = title === groupName;
                    const matchesName = name === groupName;
                    
                    elizaLogger.log(`Checking dialog - Title: ${title}, Name: ${name}, Matches: ${matchesTitle || matchesName}`);
                    return matchesTitle || matchesName;
                });
                
                if (dialog) {
                    elizaLogger.log(`Found group ${groupName} with ID: ${dialog.id}`);
                    // Schedule first marketing message
                    const delay = Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL) + this.MIN_MARKETING_INTERVAL);
                    setTimeout(() => this.sendMarketingMessage(dialog), delay);
                    elizaLogger.log(`📅 Scheduled first marketing message for ${groupName} in ${Math.floor(delay / 1000)} seconds`);
                } else {
                    elizaLogger.warn(`⚠️ Could not find group: ${groupName}. Available groups:`, 
                        dialogs.map(d => ({ title: d.title, name: d.name })));
                }
            } catch (error) {
                elizaLogger.error(`Failed to initialize marketing for group ${groupName}:`, {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
            }
        }
    }

    async handleMessage(message: Message): Promise<{ text: string } | null> {
        try {
            // Skip if we shouldn't process this message yet
            if (!await this.shouldProcessMessage(message.chat.id, message)) {
                return null;
            }

            return this.handleMessageInternal(message);
        } catch (error) {
            elizaLogger.error('Error in message handler:', error);
            return null;
        }
    }

    private async shouldProcessMessage(chatId: string, message: Message): Promise<boolean> {
        const now = Date.now();
        const lastResponseTime = this.lastResponseTimes.get(chatId) || 0;

        // Check if enough time has passed since last response
        if (now - lastResponseTime < this.MESSAGE_CONSTANTS.MIN_MESSAGE_INTERVAL) {
            elizaLogger.log('Rate limiting: Too soon since last response');
            return false;
        }

        // Initialize or get message batch
        if (!this.messageBatches.has(chatId)) {
            this.messageBatches.set(chatId, { messages: [] });
        }
        const batch = this.messageBatches.get(chatId)!;

        // Add message to batch
        batch.messages.push({
            text: message.text,
            timestamp: now
        });

        // Clear old messages from batch
        batch.messages = batch.messages.filter(msg => 
            now - msg.timestamp < this.MESSAGE_CONSTANTS.MESSAGE_BATCH_WINDOW
        );

        // If this is the first message in a new batch, set timeout to process batch
        if (batch.messages.length === 1) {
            if (batch.batchTimeout) {
                clearTimeout(batch.batchTimeout);
            }
            batch.batchTimeout = setTimeout(() => {
                this.processBatch(chatId);
            }, this.MESSAGE_CONSTANTS.MESSAGE_BATCH_WINDOW);
        }

        // Only process if this is the last message in a batch
        const isLastInBatch = batch.messages.length >= this.MESSAGE_CONSTANTS.MAX_BATCH_SIZE;
        if (isLastInBatch) {
            this.processBatch(chatId);
            return true;
        }

        return false;
    }

    private async processBatch(chatId: string): Promise<void> {
        const batch = this.messageBatches.get(chatId);
        if (!batch || batch.messages.length === 0) return;

        // Clear the batch timeout
        if (batch.batchTimeout) {
            clearTimeout(batch.batchTimeout);
        }

        // Combine messages if they were sent rapidly
        const combinedText = batch.messages
            .map(msg => msg.text)
            .join(' ');

        // Create a synthetic message with the combined text
        const lastMessage = batch.messages[batch.messages.length - 1];
        const syntheticMessage = {
            text: combinedText,
            from: batch.messages[0].from,
            chat: { id: chatId, type: 'group' }
        };

        // Process the combined message
        await this.handleMessageInternal(syntheticMessage);

        // Clear the batch
        this.messageBatches.set(chatId, { messages: [] });
    }

    private async handleMessageInternal(message: Message): Promise<{ text: string } | null> {
        try {
            // Update group activity tracking
            await this.updateGroupActivity(message);

            // Get chat context
            const chatId = message.chat.id;
            if (!this.interestChats[chatId]) {
                this.interestChats[chatId] = {
                    lastMessageSent: 0,
                    messages: [],
                    contextSimilarityThreshold: 0.7
                };
            }

            // Format character data
            const character = this.runtime.character;
            const characterData = {
                name: character.name,
                bio: Array.isArray(character.bio) ? character.bio.join('\n') : character.bio || '',
                lore: Array.isArray(character.lore) ? character.lore.join('\n') : character.lore || '',
                topics: Array.isArray(character.topics) ? character.topics.join('\n') : character.topics || '',
                knowledge: Array.isArray(character.knowledge) ? character.knowledge.join('\n') : character.knowledge || '',
                style: character.style || {}
            };

            // Get recent chat history for context
            let context = '';
            if (this.interestChats[chatId]) {
                const recentMessages = this.interestChats[chatId].messages
                    .slice(-5)
                    .map(msg => `${msg.userName}: ${msg.content.text}`)
                    .join('\n');
                context = recentMessages;
            }

            // Prepare state for response generation
            const state = {
                currentMessage: message.text,
                character: characterData,
                context,
                username: message.from.username || 'unknown',
                agentName: characterData.name,
                bio: characterData.bio,
                lore: characterData.lore,
                topics: characterData.topics,
                knowledge: characterData.knowledge,
                style: characterData.style
            };

            // Generate response
            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: telegramMessageHandlerTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            if (!response) {
                elizaLogger.log('No response generated');
                return null;
            }

            // Should we respond?
            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: telegramShouldRespondTemplate
                }),
                modelClass: ModelClass.SMALL
            });

            if (!shouldRespond) {
                elizaLogger.log('Decided not to respond to message');
                return null;
            }

            // Update conversation context
            this.interestChats[chatId].messages.push({
                userId: message.from.id,
                userName: message.from.username || 'unknown',
                content: { text: message.text }
            });

            // Keep only last N messages
            if (this.interestChats[chatId].messages.length > MESSAGE_CONSTANTS.MAX_CONTEXT_MESSAGES) {
                this.interestChats[chatId].messages = this.interestChats[chatId].messages.slice(-MESSAGE_CONSTANTS.MAX_CONTEXT_MESSAGES);
            }

            // Update last message sent time
            this.interestChats[chatId].lastMessageSent = Date.now();
            this.lastResponseTimes.set(chatId, Date.now());

            return { text: response };
        } catch (error) {
            elizaLogger.error('Error processing message:', error);
            throw error;
        }
    }

    private isGroupActive(groupId: string): boolean {
        const activity = this.groupActivities.get(groupId);
        if (!activity) return false;

        const now = Date.now();
        // Only count messages within activity window
        const recentUserMessages = activity.recentMessages.filter(msg => 
            msg.isUser && (now - msg.time) < this.MARKETING_CONSTANTS.MESSAGE_ACTIVITY_WINDOW
        );

        return recentUserMessages.length >= this.MARKETING_CONSTANTS.REQUIRED_MESSAGES;
    }

    private async canSendMarketingMessage(dialog: Dialog): Promise<boolean> {
        const groupId = dialog.id.toString();
        const activity = this.groupActivities.get(groupId);
        if (!activity) return false;

        const now = Date.now();
        const timeSinceLastMarketing = now - activity.lastMarketingTime;
        const minTimeElapsed = timeSinceLastMarketing >= this.MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL;

        // Get total marketing messages in last 24 hours
        const messages = await this.client.getMessages(dialog.entity, {
            limit: 100,
            fromUser: this.client.session.userId
        });

        const marketingMessagesLast24h = messages.filter(msg => 
            (now - msg.date.getTime() * 1000) < 24 * 60 * 60 * 1000
        ).length;

        // Check if the last message was from us
        const lastMessage = messages[0];
        const lastMessageWasMarketing = lastMessage?.fromId?.equals(this.client.session.userId) || false;

        // Get user messages since last marketing
        const userMessagesSinceMarketing = activity.recentMessages.filter(msg => 
            msg.isUser && msg.time > activity.lastMarketingTime
        ).length;

        const isActive = this.isGroupActive(groupId);

        elizaLogger.log(`Marketing check for ${dialog.title}:`, {
            timeSinceLastMarketing: Math.floor(timeSinceLastMarketing / (60 * 1000)),
            marketingMessagesLast24h,
            lastMessageWasMarketing,
            userMessagesSinceMarketing,
            isActive
        });

        // Only send if:
        // 1. Minimum time has elapsed AND
        // 2. Haven't exceeded daily limit AND
        // 3. Either:
        //    a. Group is active OR
        //    b. Minimum time has passed but last message wasn't marketing (avoid consecutive messages in dead groups)
        return (
            minTimeElapsed && 
            marketingMessagesLast24h < this.MARKETING_CONSTANTS.MAX_MESSAGES_PER_DAY &&
            (isActive || (!lastMessageWasMarketing && timeSinceLastMarketing >= this.MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL))
        );
    }

    private async sendMarketingMessage(dialog: Dialog): Promise<void> {
        try {
            elizaLogger.log(`Checking if we can send marketing message to ${dialog.title}`);

            if (!this.marketingEnabled) {
                elizaLogger.log(`Marketing is disabled for group: ${dialog.title}`);
                return;
            }

            // Check if we can send a marketing message
            if (!await this.canSendMarketingMessage(dialog)) {
                elizaLogger.log(`Cannot send marketing message to ${dialog.title}`);
                return;
            }

            // Generate and send message
            const message = await this.generateMarketingMessage();
            if (message) {
                // Simulate typing for more natural behavior
                await this.client.setTyping(dialog.entity);
                await new Promise(resolve => setTimeout(resolve, message.length * 50));
                
                await this.client.sendMessage(dialog.entity, { message });
                
                // Update activity tracking
                const groupId = dialog.id.toString();
                const activity = this.groupActivities.get(groupId);
                if (activity) {
                    activity.lastMarketingTime = Date.now();
                    activity.recentMessages.push({ time: Date.now(), isUser: false });
                }
                
                elizaLogger.log(`✅ Sent marketing message to ${dialog.title}`);

                // Schedule next check
                const nextCheck = this.MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL;
                setTimeout(() => this.sendMarketingMessage(dialog), nextCheck);
                elizaLogger.log(`📅 Scheduled next check for ${dialog.title} in ${Math.floor(nextCheck/60000)} minutes`);
            }
        } catch (error) {
            elizaLogger.error(`Error sending marketing message to ${dialog.title}:`, error);
        }
    }

    private async updateGroupActivity(message: Message): Promise<void> {
        const groupId = message.chat.id;
        const now = Date.now();

        // Initialize group activity if not exists
        if (!this.groupActivities.has(groupId)) {
            this.groupActivities.set(groupId, {
                lastMarketingTime: 0,
                recentMessages: [],
                lastDailyReset: now
            });
        }

        const activity = this.groupActivities.get(groupId)!;

        // Add the new message to recent messages
        activity.recentMessages.push({
            isUser: true,
            time: now
        });

        // Remove messages older than activity window
        activity.recentMessages = activity.recentMessages.filter(msg =>
            (now - msg.time) < this.MARKETING_CONSTANTS.MESSAGE_ACTIVITY_WINDOW
        );

        // Reset daily counters if needed
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (now - activity.lastDailyReset > oneDayMs) {
            activity.lastDailyReset = now;
        }

        this.groupActivities.set(groupId, activity);
    }

    // Rest of the code remains the same
}
