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
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    UUID,
    Media
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { Message, TextChannel } from 'discord.js-selfbot-v13';
import { DiscordUserClient } from './discordUserClient';

// Constants
const MARKETING_CONSTANTS = {
    MIN_MARKETING_INTERVAL: 15 * 60 * 1000, // 15 minutes
    MAX_MARKETING_INTERVAL: 45 * 60 * 1000, // 45 minutes
    BASE_WAIT_TIME: 6 * 60 * 60 * 1000,    // 6 hours
    MIN_MESSAGES_BEFORE_REPLY: 20,
    TIME_REDUCTION_PER_MESSAGE: 15 * 60 * 1000, // 15 minutes
    MIN_WAIT_TIME: 30 * 60 * 1000,         // 30 minutes
    MAX_MARKETING_MESSAGES_PER_GROUP: 96
};

export class MessageManager {
    private runtime: IAgentRuntime;
    private client: DiscordUserClient;
    private interestChannels: {
        [key: string]: {
            lastMessageSent: number;
            messages: { userId: string; userName: string; content: Content }[];
            contextSimilarityThreshold?: number;
        };
    } = {};
    private targetChannels: Set<string> = new Set();
    private lastMarketingTimes: Map<string, number> = new Map();
    private channelMessageCounts: Map<string, number> = new Map();
    private channelTimeReductions: Map<string, number> = new Map();
    private marketingEnabled: boolean = false;

    constructor(runtime: IAgentRuntime, client: DiscordUserClient) {
        elizaLogger.log('Initializing Discord MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    async startMarketing(): Promise<void> {
        elizaLogger.log('Starting Discord marketing...');
        this.marketingEnabled = true;
        await this.initializeChannelMarketing();
    }

    async stopMarketing(): Promise<void> {
        elizaLogger.log('Stopping Discord marketing...');
        this.marketingEnabled = false;
    }

    private normalizeChannelName(name: string): string {
        return name.toLowerCase().trim();
    }

    private async initializeChannelMarketing(): Promise<void> {
        try {
            // Get all channels the bot has access to
            const channels = await this.client.getChannels();
            for (const channel of channels) {
                if (channel instanceof TextChannel) {
                    const channelName = this.normalizeChannelName(channel.name);
                    this.targetChannels.add(channelName);
                    this.lastMarketingTimes.set(channelName, 0);
                    this.channelMessageCounts.set(channelName, 0);
                    this.channelTimeReductions.set(channelName, 0);
                }
            }
        } catch (error) {
            elizaLogger.error('Error initializing channel marketing:', error);
        }
    }

    private canSendMarketingMessage(channel: TextChannel): boolean {
        const channelName = this.normalizeChannelName(channel.name);
        const lastMessageTime = this.lastMarketingTimes.get(channelName) || 0;
        const messageCount = this.channelMessageCounts.get(channelName) || 0;
        const timeReduction = this.channelTimeReductions.get(channelName) || 0;

        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTime;
        const waitTime = Math.max(
            MARKETING_CONSTANTS.MIN_WAIT_TIME,
            MARKETING_CONSTANTS.BASE_WAIT_TIME - timeReduction
        );

        return timeSinceLastMessage >= waitTime && 
               messageCount >= MARKETING_CONSTANTS.MIN_MESSAGES_BEFORE_REPLY;
    }

    private updateChannelActivity(channel: TextChannel): void {
        const channelName = this.normalizeChannelName(channel.name);
        const messageCount = (this.channelMessageCounts.get(channelName) || 0) + 1;
        this.channelMessageCounts.set(channelName, messageCount);

        const timeReduction = Math.min(
            messageCount * MARKETING_CONSTANTS.TIME_REDUCTION_PER_MESSAGE,
            MARKETING_CONSTANTS.BASE_WAIT_TIME - MARKETING_CONSTANTS.MIN_WAIT_TIME
        );
        this.channelTimeReductions.set(channelName, timeReduction);
    }

    private resetChannelCounters(channel: TextChannel): void {
        const channelName = this.normalizeChannelName(channel.name);
        this.channelMessageCounts.set(channelName, 0);
        this.channelTimeReductions.set(channelName, 0);
        this.lastMarketingTimes.set(channelName, Date.now());
    }

    async sendMarketingMessage(channel: TextChannel): Promise<void> {
        try {
            const response = await generateMessageResponse(this.runtime, {
                text: '',
                fromId: '',
                timestamp: new Date().toISOString()
            });

            if (response) {
                await channel.send(response.text);
                this.resetChannelCounters(channel);
            }
        } catch (error) {
            elizaLogger.error('Error sending marketing message:', error);
        }
    }

    async handleMessage(message: Message): Promise<Content | null> {
        try {
            elizaLogger.log('🔄 Starting message processing:', {
                text: message.content,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Validate message
            if (!message.author.id || !message.channel.id) {
                throw new Error('Invalid message format: Missing required fields');
            }

            // Ensure message text is properly formatted
            const messageText = typeof message.content === 'object' ?
                JSON.stringify(message.content) : String(message.content || '');

            // Check if we should respond based on character's topics and rules
            const shouldRespond = this.shouldRespondToMessage(messageText, message.channel.id);
            
            if (!shouldRespond) {
                elizaLogger.log('Decided not to respond', {
                    reason: 'Message does not match character topics or rules',
                    message: messageText
                });
                return null;
            }

            // Create memory for the message
            let memory = await this.createMessageMemory(message);

            // Compose state with chat history and character details
            let state = await this.runtime.composeState(memory);
            const channelId = message.channel.id;

            // Add chat history context
            if (this.interestChannels[channelId]) {
                const recentMessages = this.interestChannels[channelId].messages
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
            state.currentMessage = messageText;
            state.username = message.author.username || 'User';

            // Generate response using character's personality
            let response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character?.templates?.discordMessageHandlerTemplate || telegramMessageHandlerTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            elizaLogger.log('🤖 Generated response:', {
                response,
                character: this.runtime.character.name,
                message: messageText
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
                userId: stringToUuid(message.author.id),
                roomId: stringToUuid(message.channel.id + "-" + this.runtime.agentId),
                content: {
                    text: responseText,
                    source: 'discord',
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
                source: 'discord',
                inReplyTo: memory.id
            };

        } catch (error) {
            elizaLogger.error('❌ Error handling message:', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                message: message.content,
                userId: message.author?.id,
                channelId: message.channel?.id,
                character: this.runtime.character?.name
            });
            return null;
        }
    }

    async createMessageMemory(message: Message): Promise<Memory> {
        const memory: Memory = {
            id: stringToUuid(message.id),
            agentId: this.runtime.agentId,
            userId: stringToUuid(message.author.id),
            roomId: stringToUuid(message.channel.id + "-" + this.runtime.agentId),
            content: {
                text: message.content,
                source: 'discord'
            },
            createdAt: message.createdTimestamp,
            embedding: getEmbeddingZeroVector(),
        };

        await this.runtime.messageManager.createMemory(memory);
        return memory;
    }

    updateChatState(message: Message, response: string): void {
        const channelId = message.channel.id;
        
        if (!this.interestChannels[channelId]) {
            this.interestChannels[channelId] = {
                lastMessageSent: Date.now(),
                messages: []
            };
        }

        // Add user message
        this.interestChannels[channelId].messages.push({
            userId: message.author.id,
            userName: message.author.username,
            content: { text: message.content }
        });

        // Add bot response
        this.interestChannels[channelId].messages.push({
            userId: this.client.client.user?.id || 'bot',
            userName: this.client.client.user?.username || 'Bot',
            content: { text: response }
        });

        // Keep only last N messages
        if (this.interestChannels[channelId].messages.length > 10) {
            this.interestChannels[channelId].messages = 
                this.interestChannels[channelId].messages.slice(-10);
        }
    }

    shouldRespondToMessage(messageText: string, channelId: string): boolean {
        try {
            // Get the channel name
            const channel = this.client.client.channels.cache.get(channelId);
            if (!channel || !(channel instanceof TextChannel)) {
                return false;
            }

            // Check if it's an allowed channel
            const channelName = channel.name;
            if (!this.client.allowedChannels.has(channelName)) {
                return false;
            }

            // Use the runtime to determine if we should respond
            const state = {
                currentMessage: messageText,
                character: {
                    name: this.runtime.character.name,
                    description: this.runtime.character.description,
                    topics: this.runtime.character.topics,
                    knowledge: this.runtime.character.knowledge,
                    style: this.runtime.character.style || {},
                    system: this.runtime.character.system
                }
            };

            const shouldRespond = generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: shouldRespondFooter
                }),
                modelClass: ModelClass.SMALL
            });

            return shouldRespond;
        } catch (error) {
            elizaLogger.error('Error in shouldRespondToMessage:', error);
            return false;
        }
    }
}
