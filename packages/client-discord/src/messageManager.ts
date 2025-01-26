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

// Base templates that incorporate character's style and behavior
export const discordMessageHandlerTemplate = `
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

    async getChatState(message: Message): Promise<State> {
        const channelId = message.channel.id;
        
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
        if (this.interestChannels[channelId]) {
            const recentMessages = this.interestChannels[channelId].messages
                .slice(-5)
                .map(msg => `${msg.userName}: ${msg.content.text}`)
                .join('\n');
            context = recentMessages;
        }

        const state: State = {
            currentMessage: message.content,
            character: characterData,
            context,
            username: message.author.username,
            agentName: characterData.name,
            bio: characterData.bio,
            lore: characterData.lore,
            topics: characterData.topics,
            knowledge: characterData.knowledge,
            style: characterData.style
        };

        elizaLogger.log('📝 Prepared chat state:', {
            hasContext: !!state.context,
            contextLength: state.context?.length || 0,
            characterName: state.character?.name,
            messageText: state.currentMessage
        });

        return state;
    }

    async generateResponse(message: Message, state: State): Promise<string | null> {
        try {
            elizaLogger.log('🔄 Generating response with context:', {
                messageLength: message.content.length,
                contextLength: state.context?.length || 0,
                characterName: this.runtime.character?.name
            });

            // Generate response using character's personality and context
            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: discordMessageHandlerTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            if (!response) {
                elizaLogger.warn('No response generated');
                return null;
            }

            // Format response
            const responseText = typeof response === 'string' ? response : response.text;
            if (!responseText) {
                elizaLogger.warn('Empty response text');
                return null;
            }

            elizaLogger.log('🤖 Generated response:', {
                responseLength: responseText.length,
                character: this.runtime.character?.name,
                message: message.content
            });

            // Update chat state
            this.updateChatState(message, responseText);

            return responseText;

        } catch (error) {
            elizaLogger.error('❌ Error generating response:', {
                error: error instanceof Error ? error.message : String(error),
                message: message.content
            });
            return null;
        }
    }

    async handleMessage(message: Message): Promise<{ text: string } | null> {
        try {
            // Skip messages from self
            if (message.author.id === this.client.client.user?.id) {
                return null;
            }

            elizaLogger.log('📨 Received message:', {
                text: message.content,
                channelName: message.channel.name,
                fromId: message.author.id,
                timestamp: new Date().toISOString()
            });

            // Check if we should respond
            const shouldRespond = await this.shouldRespondToMessage(message.content, message.channel.id);
            if (!shouldRespond) {
                return null;
            }

            elizaLogger.log('🤔 Should respond check:', {
                channelName: message.channel.name,
                messageText: message.content,
                shouldRespond: 'RESPOND'
            });

            // Create memory for the message
            const memory = await this.createMessageMemory(message);
            elizaLogger.log('📝 Creating memory:', {
                messageId: memory.id,
                roomId: memory.roomId,
                channelName: message.channel.name
            });

            // Get chat state with context
            const state = await this.getChatState(message);
            elizaLogger.log('📝 Prepared chat state:', {
                hasContext: !!state.context,
                contextLength: state.context?.length || 0,
                characterName: this.runtime.character?.name
            });

            // Generate response using character's personality
            const response = await this.generateResponse(message, state);
            if (!response) {
                elizaLogger.warn('No response generated');
                return null;
            }

            return { text: response };

        } catch (error) {
            elizaLogger.error('❌ Error handling message:', {
                error: error instanceof Error ? error.message : String(error),
                message: message.content,
                channelId: message.channel.id
            });
            return null;
        }
    }

    private updateChatState(message: Message, response: string): void {
        const channelId = message.channel.id;

        // Initialize channel state if not exists
        if (!this.interestChannels[channelId]) {
            this.interestChannels[channelId] = {
                lastMessageSent: Date.now(),
                messages: [],
            };
        }

        // Update last message sent time
        this.interestChannels[channelId].lastMessageSent = Date.now();

        // Add user message to chat history
        this.interestChannels[channelId].messages.push({
            userId: message.author.id,
            userName: message.author.username,
            content: {
                text: message.content,
                source: 'discord'
            }
        });

        // Add bot's response to chat history
        this.interestChannels[channelId].messages.push({
            userId: this.runtime.agentId,
            userName: this.runtime.character.name,
            content: {
                text: response,
                source: 'discord'
            }
        });

        // Keep only last N messages for context
        const maxMessages = 10;
        if (this.interestChannels[channelId].messages.length > maxMessages) {
            this.interestChannels[channelId].messages = this.interestChannels[channelId].messages.slice(-maxMessages);
        }
    }

    async createMessageMemory(message: Message): Promise<Memory> {
        // Create a unique room ID for each channel
        const roomId = stringToUuid(`discord-${message.channel.id}-${this.runtime.agentId}`);

        // Create memory
        const memory: Memory = {
            id: stringToUuid(message.id),
            agentId: this.runtime.agentId,
            userId: stringToUuid(message.author.id),
            roomId,
            content: {
                text: message.content,
                source: 'discord',
                metadata: {
                    channelId: message.channel.id,
                    channelName: message.channel instanceof TextChannel ? message.channel.name : 'unknown',
                    guildId: message.guild?.id,
                    guildName: message.guild?.name
                }
            },
            createdAt: message.createdTimestamp,
            embedding: getEmbeddingZeroVector(),
        };

        elizaLogger.log('📝 Creating memory:', {
            messageId: message.id,
            roomId,
            channelName: message.channel.name
        });

        await this.runtime.messageManager.createMemory(memory);
        return memory;
    }

    async shouldRespondToMessage(messageText: string, channelId: string): Promise<boolean> {
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
                    bio: Array.isArray(this.runtime.character.bio) ? this.runtime.character.bio.join('\n') : '',
                    topics: Array.isArray(this.runtime.character.topics) ? this.runtime.character.topics.join('\n') : '',
                    knowledge: Array.isArray(this.runtime.character.knowledge) ? this.runtime.character.knowledge.join('\n') : '',
                    style: this.runtime.character.style || {},
                    system: this.runtime.character.system
                }
            };

            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character.templates?.shouldRespondTemplate || shouldRespondFooter
                }),
                modelClass: ModelClass.SMALL
            });

            elizaLogger.log('🤔 Should respond check:', {
                channelName,
                messageText: messageText.substring(0, 50),
                shouldRespond
            });

            return shouldRespond;
        } catch (error) {
            elizaLogger.error('Error in shouldRespondToMessage:', error);
            return false;
        }
    }
}
