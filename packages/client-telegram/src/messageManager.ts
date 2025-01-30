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
    
    // Base timing constants
    private readonly MIN_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly MAX_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly BASE_WAIT_TIME = 6 * 60 * 60 * 1000;        // 6 hours
    private readonly MIN_MESSAGES_BEFORE_REPLY = 2;
    private readonly TIME_REDUCTION_PER_MESSAGE = 30 * 60 * 1000; // 30 minutes
    private readonly MIN_WAIT_TIME = 4 * 60 * 60 * 1000;         // 4 hours
    private readonly MAX_MARKETING_MESSAGES_PER_GROUP = 4;        // 4 messages per day max (24/6)
    private marketingEnabled: boolean = false;

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

    private canSendMarketingMessage(dialog: Dialog): boolean {
        const groupId = dialog.id.toString();
        const now = Date.now();
        const lastMessageTime = this.lastMarketingTimes.get(groupId) || 0;
        
        // For testing: Only check if 2 minutes have passed since last message
        const timeOk = (now - lastMessageTime) >= this.MIN_MARKETING_INTERVAL;
        
        elizaLogger.log(`Marketing check for ${dialog.title}:`, {
            timePassedSeconds: Math.floor((now - lastMessageTime) / 1000),
            requiredWaitTimeSeconds: Math.floor(this.MIN_MARKETING_INTERVAL / 1000),
            canSend: timeOk
        });

        return timeOk;
    }

    private updateGroupActivity(dialog: Dialog) {
        const groupId = dialog.id.toString();
        
        // Increment message count
        const currentCount = this.groupMessageCounts.get(groupId) || 0;
        this.groupMessageCounts.set(groupId, currentCount + 1);

        // If we've reached message threshold, add time reduction
        if ((currentCount + 1) % this.MIN_MESSAGES_BEFORE_REPLY === 0) {
            const currentReduction = this.groupTimeReductions.get(groupId) || 0;
            const newReduction = Math.min(
                this.BASE_WAIT_TIME - this.MIN_WAIT_TIME, // Don't reduce below minimum wait time
                currentReduction + this.TIME_REDUCTION_PER_MESSAGE
            );
            this.groupTimeReductions.set(groupId, newReduction);
            
            elizaLogger.log(`Updated time reduction for ${dialog.title}:`, {
                newReductionMinutes: Math.floor(newReduction / (60 * 1000)),
                messageCount: currentCount + 1
            });
        }
    }

    private resetGroupCounters(dialog: Dialog) {
        const groupId = dialog.id.toString();
        this.groupMessageCounts.set(groupId, 0);
        this.lastMarketingTimes.set(groupId, Date.now());
    }

    private async sendMarketingMessage(dialog: Dialog): Promise<void> {
        try {
            const groupId = dialog.id.toString();
            elizaLogger.log(`Checking if we can send marketing message to ${dialog.title} (${groupId})`);

            // Check if marketing is enabled
            if (!this.marketingEnabled) {
                elizaLogger.log(`Marketing is disabled for group: ${dialog.title}`);
                return;
            }

            // Check if we can send a message based on time and activity
            if (!this.canSendMarketingMessage(dialog)) {
                elizaLogger.log(`Conditions not met for marketing message in ${dialog.title}`);
                
                // Schedule next check
                const nextCheck = Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL) + this.MIN_MARKETING_INTERVAL);
                setTimeout(() => this.sendMarketingMessage(dialog), nextCheck);
                elizaLogger.log(`📅 Scheduled next check for ${dialog.title} in ${Math.floor(nextCheck / 60000)} minutes`);
                return;
            }

            // Check if we've exceeded max messages per day for this group
            const messageCount = await this.getMarketingMessageCountToday(dialog);
            elizaLogger.log(`Current message count for ${dialog.title}: ${messageCount}/${this.MAX_MARKETING_MESSAGES_PER_GROUP}`);
            
            if (messageCount >= this.MAX_MARKETING_MESSAGES_PER_GROUP) {
                elizaLogger.log(`⚠️ Max marketing messages reached for group: ${dialog.title}`);
                return;
            }

            // Generate marketing message using character profile
            elizaLogger.log(`Generating marketing message for ${dialog.title}`);
            
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
                    messageType: 'marketing'
                },
                roomId: stringToUuid(`${groupId}-${this.runtime.agentId}`),
                agentId: this.runtime.agentId,
                userId: stringToUuid(this.client.session.userId?.toString() || 'system')
            };

            // Create state with character information
            const state = {
                character: this.runtime.character,
                agentName: this.runtime.character?.name || 'Agent',
                bio: this.runtime.character?.description || '',
                style: this.runtime.character?.style || {},
                topics: this.runtime.character?.topics || [],
                knowledge: this.runtime.character?.knowledge || [],
                lore: this.runtime.character?.lore || '',
                system: this.runtime.character?.system || '',
                prompt: {
                    text: 'Generate an engaging marketing message that promotes our services while staying true to the character\'s style and personality.',
                    type: 'marketing'
                }
            };

            elizaLogger.log(`Generating response for ${dialog.title} with character:`, {
                name: state.agentName,
                hasStyle: !!state.style,
                hasTopics: !!state.topics?.length,
                hasKnowledge: !!state.knowledge?.length
            });

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: telegramMarketingTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            // Ensure response is properly formatted
            let responseText: string;
            if (typeof response === 'string') {
                responseText = response;
            } else if (typeof response === 'object' && response.text) {
                responseText = String(response.text);
            } else {
                elizaLogger.warn('Invalid response format:', response);
                return;
            }

            elizaLogger.log(`Generated message for ${dialog.title}, simulating typing...`);
            // Simulate typing before sending
            try {
                await this.client.setTyping(dialog.id);
                await new Promise(resolve => setTimeout(resolve, responseText.length * 100));
                await this.client.setTyping(dialog.id, { typing: false });
            } catch (error) {
                elizaLogger.warn(`Failed to set typing indicator for ${dialog.title}:`, error);
                // Continue anyway since this is not critical
            }

            elizaLogger.log(`Sending message to ${dialog.title}`);
            await this.client.sendMessage(dialog.id, {
                message: responseText,
                parseMode: 'markdown'
            });

            // Create response memory
            const responseMemory: Memory = {
                id: stringToUuid(Date.now().toString()),
                agentId: this.runtime.agentId,
                userId: stringToUuid(this.client.session.userId?.toString() || 'system'),
                roomId: stringToUuid(`${groupId}-${this.runtime.agentId}`),
                content: {
                    text: responseText,
                    source: 'telegram',
                    type: 'marketing'
                },
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            await this.runtime.messageManager.createMemory(responseMemory);

            this.lastMarketingTimes.set(groupId, Date.now());
            elizaLogger.success(`✅ Sent marketing message to ${dialog.title}`);

            // Schedule next marketing message
            const nextDelay = Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL) + this.MIN_MARKETING_INTERVAL);
            setTimeout(() => this.sendMarketingMessage(dialog), nextDelay);
            elizaLogger.log(`📅 Scheduled next message for ${dialog.title} in ${Math.floor(nextDelay / 60000)} minutes`);
        } catch (error) {
            elizaLogger.error(`Failed to send marketing message to ${dialog.title}:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                dialogId: dialog.id,
                dialogTitle: dialog.title,
                dialogType: dialog.type,
                runtime: {
                    hasModelProvider: !!this.runtime?.modelProvider,
                    hasCharacter: !!this.runtime?.character
                }
            });
            
            // Schedule retry even if failed
            const retryDelay = Math.floor(Math.random() * (this.MAX_MARKETING_INTERVAL - this.MIN_MARKETING_INTERVAL) + this.MIN_MARKETING_INTERVAL);
            setTimeout(() => this.sendMarketingMessage(dialog), retryDelay);
            elizaLogger.log(`📅 Scheduled retry for ${dialog.title} in ${Math.floor(retryDelay / 60000)} minutes`);
        }
    }

    public async handleMessage(message: Message): Promise<Content | null> {
        try {
            // Handle both Telegram and Discord message structures
            const chatInfo = {
                id: message.chat?.id || message.channelId,
                type: message.chat?.type || 'channel',
                title: message.chat?.title
            };

            if (!chatInfo.id) {
                elizaLogger.warn('Invalid message format: Missing chat/channel ID');
                return null;
            }

            elizaLogger.log('🔄 Starting message processing:', {
                text: message.text,
                chatId: chatInfo.id,
                userId: message.from?.id || message.author?.id
            });

            // Validate message
            const userId = message.from?.id || message.author?.id;
            if (!userId) {
                throw new Error('Invalid message format: Missing user ID');
            }

            // Ensure message text is properly formatted
            message.text = typeof message.text === 'object' ?
                JSON.stringify(message.text) : String(message.text || '');

            // Check if we should respond based on character's topics and rules
            const shouldRespond = this.shouldRespondToMessage(message.text, chatInfo.id);
            
            if (!shouldRespond) {
                elizaLogger.log('Decided not to respond', {
                    reason: 'Message does not match character topics or rules',
                    message: message.text
                });
                return null;
            }

            // Create memory for the message
            let memory = await this.createMessageMemory(message);

            // Compose state with chat history and character details
            let state = await this.runtime.composeState(memory);
            const chatId = chatInfo.id;

            // Add chat history context
            if (this.interestChats[chatId]) {
                const recentMessages = this.interestChats[chatId].messages
                    .slice(-5)
                    .map(msg => `${msg.userName}: ${msg.content.text}`)
                    .join('\n');
                    
                state.context = `Recent conversation:\n${recentMessages}`;
            }

            // Add character context including style and behavior
            state.character = {
                name: this.runtime.character.name,
                description: this.runtime.character.description,
                topics: this.runtime.character.topics,
                knowledge: this.runtime.character.knowledge,
                style: this.runtime.character.style || {},
                system: this.runtime.character.system
            };

            // Add current message and user info
            state.currentMessage = message.text;
            state.username = message.from?.username || message.author?.username || 'User';

            // Generate response using character's personality
            let response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramMessageHandlerTemplate || telegramMessageHandlerTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            elizaLogger.log('🤖 Generated response:', {
                response,
                character: this.runtime.character.name,
                message: message.text
            });

            // Ensure response is properly formatted
            let responseText: string;
            if (typeof response === 'string') {
                responseText = response;
            } else if (typeof response === 'object' && response.text) {
                responseText = String(response.text);
            } else {
                elizaLogger.warn('Invalid response format:', response);
                return null;
            }

            // Update chat state
            this.updateChatState(message, responseText);

            // Create response memory with proper content structure
            const responseMemory: Memory = {
                id: stringToUuid(Date.now().toString()),
                agentId: this.runtime.agentId,
                userId: stringToUuid(message.from?.id || message.author?.id),
                roomId: stringToUuid(message.chat?.id + "-" + this.runtime.agentId || message.channelId + "-" + this.runtime.agentId),
                content: {
                    text: responseText,
                    source: 'telegram',
                    inReplyTo: memory.id
                },
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            await this.runtime.messageManager.createMemory(responseMemory);

            return {
                type: 'text',
                text: responseText,
                content: responseText,
                source: 'telegram',
                inReplyTo: memory.id
            };

        } catch (error) {
            elizaLogger.error('❌ Error handling message:', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                message: message.text,
                userId: message.from?.id || message.author?.id,
                chatId: message.chat?.id || message.channelId,
                character: this.runtime.character?.name
            });
            return null;
        }
    }

    private async createMessageMemory(message: Message): Promise<Memory> {
        try {
            const userId = stringToUuid(message.from?.id || message.author?.id);
            const roomId = stringToUuid(message.chat?.id + "-" + this.runtime.agentId || message.channelId + "-" + this.runtime.agentId);
            const messageId = stringToUuid(Date.now().toString());

            // Ensure message content is properly formatted
            const messageText = typeof message.text === 'object' ?
                JSON.stringify(message.text) : String(message.text || '');

            // Create memory content object
            const content: Content = {
                text: messageText,
                source: 'telegram',
                inReplyTo: message.replyTo ? stringToUuid(message.replyTo.messageId) : undefined
            };

            // Ensure connection exists
            await this.runtime.ensureConnection(
                userId,
                roomId,
                message.from?.username || message.author?.username || '',
                message.from?.firstName || message.author?.firstName || '',
                'telegram'
            );

            // Create memory object
            const memory: Memory = {
                id: messageId,
                agentId: this.runtime.agentId,
                userId,
                roomId,
                content,
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            // Store memory
            await this.runtime.messageManager.createMemory(memory);
            elizaLogger.log('Memory created successfully:', { id: memory.id, userId, roomId });
            return memory;
        } catch (error) {
            elizaLogger.error('Error creating memory:', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                message: message.text,
                userId: message.from?.id || message.author?.id,
                chatId: message.chat?.id || message.channelId
            });
            throw error;
        }
    }

    private updateChatState(message: Message, response: string): void {
        try {
            const chatId = message.chat?.id || message.channelId;

            // Initialize chat state if not exists
            if (!this.interestChats[chatId]) {
                this.interestChats[chatId] = {
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            }

            // Update last message sent time
            this.interestChats[chatId].lastMessageSent = Date.now();

            // Ensure message content is properly formatted
            const messageText = typeof message.text === 'object' ?
                JSON.stringify(message.text) : String(message.text || '');

            // Add message to chat history with proper content structure
            this.interestChats[chatId].messages.push({
                userId: message.from?.id || message.author?.id,
                userName: message.from?.username || message.author?.username || 'Unknown',
                content: {
                    text: messageText,
                    source: 'telegram'
                }
            });

            // Add bot's response to chat history with proper content structure
            this.interestChats[chatId].messages.push({
                userId: this.runtime.agentId,
                userName: this.runtime.character.name,
                content: {
                    text: String(response),
                    source: 'telegram'
                }
            });

            // Keep only last N messages
            const maxMessages = 10;
            if (this.interestChats[chatId].messages.length > maxMessages) {
                this.interestChats[chatId].messages = this.interestChats[chatId].messages.slice(-maxMessages);
            }

            elizaLogger.log('Chat state updated:', {
                chatId,
                messageCount: this.interestChats[chatId].messages.length,
                lastMessage: response
            });
        } catch (error) {
            elizaLogger.error('Error updating chat state:', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                chatId: message.chat?.id || message.channelId
            });
            throw error;
        }
    }

    private splitMessage(text: string): string[] {
        try {
            const chunks: string[] = [];
            let currentChunk = '';

            const words = text.split(' ');
            for (const word of words) {
                if ((currentChunk + ' ' + word).length <= MAX_MESSAGE_LENGTH) {
                    currentChunk += (currentChunk ? ' ' : '') + word;
                } else {
                    chunks.push(currentChunk);
                    currentChunk = word;
                }
            }

            if (currentChunk) {
                chunks.push(currentChunk);
            }

            return chunks;
        } catch (error) {
            elizaLogger.error('Error splitting message:', error);
            throw error;
        }
    }

    private shouldRespondToMessage(messageText: string, chatId: string): boolean {
        if (!this.runtime.character) {
            return false;
        }

        const text = messageText.toLowerCase();
        
        // Check if message contains character's name or aliases
        const nameMatch = text.includes(this.runtime.character.name.toLowerCase());
        
        // Check if message matches character's topics
        const topicMatch = this.runtime.character.topics?.some(topic => 
            text.includes(topic.toLowerCase())
        );

        // Get character's response rules
        const responseRules = this.runtime.character.style?.response_rules || [];
        
        // Check against response patterns
        const respondPatterns = responseRules
            .filter(rule => rule.toLowerCase().startsWith('respond:'))
            .map(rule => rule.toLowerCase().replace('respond:', '').trim().split(','))
            .flat()
            .map(pattern => pattern.trim());
            
        const ignorePatterns = responseRules
            .filter(rule => rule.toLowerCase().startsWith('ignore:'))
            .map(rule => rule.toLowerCase().replace('ignore:', '').trim().split(','))
            .flat()
            .map(pattern => pattern.trim());
            
        const shouldRespond = respondPatterns.some(pattern => text.includes(pattern));
        const shouldIgnore = ignorePatterns.some(pattern => text.includes(pattern));
        
        // Calculate similarity with recent messages to avoid repetition
        if (this.interestChats[chatId]) {
            const recentMessages = this.interestChats[chatId].messages.slice(-5);
            const similarMessage = recentMessages.find(msg => 
                cosineSimilarity(msg.content.text.toLowerCase(), text) > 0.8
            );
            if (similarMessage) {
                return false;
            }
        }

        return (nameMatch || topicMatch || shouldRespond) && !shouldIgnore;
    }

    private async getMarketingMessageCountToday(dialog: Dialog): Promise<number> {
        try {
            elizaLogger.log(`Getting message count for ${dialog.title}`);
            const messages = await this.client.getMessages(dialog, {
                limit: this.MAX_MARKETING_MESSAGES_PER_GROUP,
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
}
