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
    MIN_MARKETING_INTERVAL: 2 * 60 * 1000,  // 2 minutes
    MAX_MARKETING_INTERVAL: 2 * 60 * 1000,  // 2 minutes
    BASE_WAIT_TIME: 4 * 60 * 1000,         // 4 minutes
    MIN_MESSAGES_BEFORE_REPLY: 2,          // Reduced for testing
    TIME_REDUCTION_PER_MESSAGE: 1 * 60 * 1000, // 1 minute
    MIN_WAIT_TIME: 2 * 60 * 1000,         // 2 minutes
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
    private readonly MIN_MARKETING_INTERVAL = 2 * 60 * 1000; // 2 minutes
    private readonly MAX_MARKETING_INTERVAL = 2 * 60 * 1000; // 2 minutes
    private readonly MAX_MARKETING_MESSAGES_PER_CHANNEL = 96; // Max messages per channel per day
    private marketingEnabled: boolean = false;

    constructor(runtime: IAgentRuntime, client: DiscordUserClient) {
        elizaLogger.log('Initializing Discord MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    async startMarketing(): Promise<void> {
        try {
            elizaLogger.log('Starting Discord marketing...');

            // Get allowed channels from settings
            const allowedChannelsStr = this.runtime.getSetting('DISCORD_ALLOWED_CHANNELS');
            if (allowedChannelsStr?.trim()) {
                const channels = allowedChannelsStr.split(',').map(name => name.trim());
                this.targetChannels = new Set(channels);
                elizaLogger.log('📢 Marketing initialized for channels:', Array.from(this.targetChannels));
            }

            this.marketingEnabled = true;
            elizaLogger.log('✅ Marketing started successfully');

            // Start marketing for each target channel
            for (const channelName of this.targetChannels) {
                this.scheduleNextMarketingMessage(channelName);
            }
        } catch (error) {
            elizaLogger.error('❌ Failed to start marketing:', error);
            throw error;
        }
    }

    private scheduleNextMarketingMessage(channelName: string): void {
        if (!this.marketingEnabled) return;

        const interval = this.MIN_MARKETING_INTERVAL;  // Use fixed 2-minute interval for testing
        elizaLogger.log(`Scheduling next marketing message for ${channelName} in ${Math.floor(interval/1000)} seconds`);

        setTimeout(async () => {
            try {
                if (!this.marketingEnabled) return;

                const channels = await this.client.getChannels();
                const channel = channels.find(c => c.name === channelName);
                
                if (channel && channel instanceof TextChannel) {
                    await this.sendMarketingMessage(channel);
                }
                
                // Schedule next message immediately after sending
                this.scheduleNextMarketingMessage(channelName);
            } catch (error) {
                elizaLogger.error('Error in marketing message schedule:', error);
                // Retry after a short delay
                setTimeout(() => this.scheduleNextMarketingMessage(channelName), 5000);
            }
        }, interval);
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
        const channelName = channel.name;
        const now = Date.now();
        const lastMessageTime = this.lastMarketingTimes.get(channelName) || 0;
        
        // For testing: Only check if 2 minutes have passed since last message
        const timeOk = (now - lastMessageTime) >= this.MIN_MARKETING_INTERVAL;
        
        elizaLogger.log(`Marketing check for ${channelName}:`, {
            timePassedSeconds: Math.floor((now - lastMessageTime) / 1000),
            requiredWaitTimeSeconds: Math.floor(this.MIN_MARKETING_INTERVAL / 1000),
            canSend: timeOk
        });

        return timeOk;
    }

    async sendMarketingMessage(channel: TextChannel): Promise<void> {
        try {
            elizaLogger.log(`Attempting to send marketing message to ${channel.name}`);
            
            // Check if we can send a message
            if (!this.canSendMarketingMessage(channel)) {
                elizaLogger.log(`Cannot send marketing message to ${channel.name} yet`);
                return;
            }

            // Generate marketing message using character's marketing style
            const marketingPrompt = {
                text: "Generate a marketing message",
                context: {
                    channelName: channel.name,
                    channelTopic: channel.topic || '',
                    marketingGoal: "Engage users and promote discussion"
                },
                fromId: 'marketing',
                timestamp: new Date().toISOString()
            };

            const response = await generateMessageResponse(this.runtime, marketingPrompt);
            
            if (response) {
                elizaLogger.log(`Sending marketing message to ${channel.name}: ${response}`);
                await channel.send(response);
                this.resetChannelCounters(channel);
            } else {
                elizaLogger.error('Failed to generate marketing message');
            }
        } catch (error) {
            elizaLogger.error('Error sending marketing message:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                channel: channel.name
            });
        }
    }

    private updateChannelActivity(channel: TextChannel): void {
        // Simplified version for testing
        const channelName = channel.name;
        this.lastMarketingTimes.set(channelName, Date.now());
    }

    private resetChannelCounters(channel: TextChannel): void {
        const channelName = channel.name;
        this.lastMarketingTimes.set(channelName, Date.now());
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

    async shouldRespondToMessage(messageText: string, channelId: string): Promise<boolean> {
        try {
            // Skip empty messages
            if (!messageText || !this.runtime.character) {
                return false;
            }

            // Get the channel
            const channel = this.client.getClient().channels.cache.get(channelId);
            if (!channel || !(channel instanceof TextChannel)) {
                return false;
            }

            // Check if it's an allowed channel
            const channelName = channel.name.toLowerCase();
            if (!this.client.getAllowedChannels().has(channelName)) {
                return false;
            }

            const text = messageText.toLowerCase();

            // Check if message contains character's name or aliases
            const nameMatch = text.includes(this.runtime.character.name.toLowerCase());

            // Check if message matches character's topics
            const topics = this.runtime.character.topics || [];
            const topicMatch = topics.some(topic => {
                const normalizedTopic = topic.toLowerCase();
                // Check for exact word match or as part of compound words
                const regex = new RegExp(`\\b${normalizedTopic}\\b|\\b${normalizedTopic}s?\\b|\\b${normalizedTopic}ing\\b`);
                return regex.test(text);
            });

            // Get character's response rules
            const responseRules = this.runtime.character.style?.response_rules || [];

            // Check against response patterns
            const respondPatterns = responseRules
                .filter(rule => rule.toLowerCase().startsWith('respond:'))
                .map(rule => rule.toLowerCase().replace('respond:', '').trim().split(','))
                .flat()
                .map(pattern => pattern.trim());

            // Check if message matches any response patterns
            const patternMatch = respondPatterns.some(pattern => {
                const regex = new RegExp(`\\b${pattern}\\b`);
                return regex.test(text);
            });

            // Only use AI-based shouldRespond if there's a topic match or name mention
            // This prevents the bot from responding to completely off-topic messages
            if (!nameMatch && !topicMatch && !patternMatch) {
                return false;
            }

            // Double-check with AI if we should respond
            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state: {
                        currentMessage: messageText,
                        character: this.runtime.character
                    },
                    template: shouldRespondFooter
                }),
                modelClass: ModelClass.SMALL
            });

            elizaLogger.log('🤔 Should respond check:', {
                channelName,
                messageText: messageText.substring(0, 50),
                nameMatch,
                topicMatch,
                patternMatch,
                shouldRespond
            });

            return shouldRespond;

        } catch (error) {
            elizaLogger.error('Error checking if should respond:', error);
            return false;
        }
    }

    async handleMessage(message: Message): Promise<{ text: string } | null> {
        try {
            elizaLogger.log('🔄 Starting message processing:', {
                text: message.content,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Update channel activity for marketing
            if (message.channel instanceof TextChannel) {
                this.updateChannelActivity(message.channel);
            }

            // Get chat state
            const state = await this.getChatState(message);
            
            // Generate response
            const response = await this.generateResponse(message, state);
            
            if (!response) {
                elizaLogger.log('ℹ️ No response to send');
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
}
