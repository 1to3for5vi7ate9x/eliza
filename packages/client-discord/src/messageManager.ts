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
import { Message, TextChannel, TextBasedChannel } from 'discord.js-selfbot-v13';
import { DiscordUserClient } from './discordUserClient';

// Constants for marketing timing and activity tracking
const MARKETING_CONSTANTS = {
    MIN_MARKETING_INTERVAL: 2 * 60 * 1000,    // 2 minutes for testing (normally 6 hours)
    REQUIRED_MESSAGES: 3,                     // Number of messages needed to consider group active
    MESSAGE_ACTIVITY_WINDOW: 5 * 60 * 1000,   // 5 minute window to count messages
    MAX_MESSAGES_PER_DAY: 50                  // Maximum marketing messages per day
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

export const discordMarketingTemplate = `
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
Generate a casual message for marketing.
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
    private groupActivities: Map<string, {
        lastMarketingTime: number;
        recentMessages: { isUser: boolean; time: number }[];
        dailyMarketingCount: number;
        lastDailyReset: number;
    }> = new Map();
    private marketingEnabled: boolean = false;

    constructor(runtime: IAgentRuntime, client: DiscordUserClient) {
        elizaLogger.log('Initializing Discord MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    async startMarketing(): Promise<void> {
        try {
            elizaLogger.log('Starting marketing functionality...');

            // Initialize activity tracking for all channels
            const channels = await this.client.getChannels();
            for (const channel of channels) {
                const channelName = channel.name.toLowerCase();
                if (!this.groupActivities.has(channelName)) {
                    this.groupActivities.set(channelName, {
                        lastMarketingTime: 0,  // Set to 0 to allow immediate first message
                        recentMessages: [],
                        dailyMarketingCount: 0,
                        lastDailyReset: Date.now()
                    });
                }
            }

            // Enable marketing
            this.marketingEnabled = true;
            elizaLogger.log('Marketing enabled for channels:', channels.map(c => c.name));

            // Start initial timers for each channel
            for (const channel of channels) {
                const channelName = channel.name.toLowerCase();
                if (this.client.getAllowedChannels().has(channelName)) {
                    elizaLogger.log(`Setting up initial timer for ${channelName}`);
                    // Random delay between 1-2 minutes for initial messages
                    const initialDelay = Math.floor(Math.random() * 60 * 1000) + 60 * 1000;
                    setTimeout(() => {
                        if (this.marketingEnabled) {
                            elizaLogger.log(`Initial timer triggered for ${channelName}`);
                            this.sendMarketingMessage(channelName).catch(error => {
                                elizaLogger.error(`Error in initial marketing message for ${channelName}:`, error);
                            });
                        }
                    }, initialDelay);
                }
            }

            elizaLogger.log('Marketing functionality started successfully');
        } catch (error) {
            elizaLogger.error('Error starting marketing:', error);
            throw error;
        }
    }

    async stopMarketing(): Promise<void> {
        elizaLogger.log('Stopping Discord marketing...');
        this.marketingEnabled = false;
    }

    async sendMarketingMessage(channelName: string): Promise<void> {
        try {
            elizaLogger.log(`Checking if we can send marketing message to ${channelName}`);

            if (!this.marketingEnabled) {
                elizaLogger.log(`Marketing is disabled for channel: ${channelName}`);
                return;
            }

            // Get channel and verify it exists
            elizaLogger.log(`Fetching channel: ${channelName}`);
            const channels = await this.client.getChannels();
            const channel = channels.find(ch => ch.name.toLowerCase() === channelName.toLowerCase());
            
            if (!channel) {
                elizaLogger.error(`Channel ${channelName} not found`);
                return;
            }

            // Check if we can send a marketing message
            elizaLogger.log('Checking marketing conditions...');
            const canSend = await this.canSendMarketingMessage(channelName, channel);
            if (!canSend) {
                elizaLogger.log(`Cannot send marketing message to ${channelName}`);
                return;
            }

            // Generate and send message
            elizaLogger.log('Generating marketing message...');
            const message = await this.generateMarketingMessage();
            if (!message) {
                elizaLogger.warn('Failed to generate marketing message');
                return;
            }

            try {
                // Simulate typing for more natural behavior
                elizaLogger.log('Sending typing indicator...');
                await this.client.setTyping(channel.id);
                await new Promise(resolve => setTimeout(resolve, message.length * 50));
                
                // Send the message
                elizaLogger.log('Sending message...');
                await this.client.sendMessage(channel.id, { message });
                
                // Update activity tracking
                elizaLogger.log('Updating activity tracking...');
                const activity = this.groupActivities.get(channelName);
                if (activity) {
                    activity.lastMarketingTime = Date.now();
                    activity.recentMessages.push({ time: Date.now(), isUser: false });
                    activity.dailyMarketingCount++;
                    elizaLogger.log(`Updated marketing count for ${channelName}: ${activity.dailyMarketingCount}`);
                } else {
                    elizaLogger.warn(`No activity tracking found for ${channelName}`);
                }
                
                elizaLogger.log(`Sent marketing message to ${channelName}`);

                // Schedule next check
                const nextCheck = MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL;
                setTimeout(() => this.sendMarketingMessage(channelName), nextCheck);
                elizaLogger.log(`Scheduled next check for ${channelName} in ${Math.floor(nextCheck/60000)} minutes`);
            } catch (sendError) {
                elizaLogger.error('Error in message sending flow:', {
                    error: sendError instanceof Error ? sendError.message : String(sendError),
                    stack: sendError instanceof Error ? sendError.stack : undefined,
                    channelName,
                    messageLength: message.length
                });
            }
        } catch (error) {
            elizaLogger.error('Error in marketing message flow:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                channelName
            });
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

        elizaLogger.log('Prepared chat state:', {
            hasContext: !!state.context,
            contextLength: state.context?.length || 0,
            characterName: state.character?.name,
            messageText: state.currentMessage
        });

        return state;
    }

    async generateResponse(message: Message, state: State): Promise<string | null> {
        try {
            elizaLogger.log('Generating response with context:', {
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

            elizaLogger.log('Generated response:', {
                responseLength: responseText.length,
                character: this.runtime.character?.name,
                message: message.content
            });

            // Update chat state
            this.updateChatState(message, responseText);

            return responseText;

        } catch (error) {
            elizaLogger.error('Error generating response:', {
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

            elizaLogger.log('Should respond check:', {
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
            // Skip messages from the bot itself
            const botId = this.client.getUserId();
            if (message.author.id === botId) {
                return null;
            }

            elizaLogger.log('Starting message processing:', {
                text: message.content,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Check if we should respond
            const shouldRespond = await this.shouldRespondToMessage(message.content, message.channel.id);
            if (!shouldRespond) {
                // Update channel activity for marketing even if we don't respond
                if (message.channel instanceof TextChannel) {
                    this.updateChannelActivity(message.channel);
                }
                return null;
            }

            // Get chat state
            const state = await this.getChatState(message);

            // Generate response
            const response = await this.generateResponse(message, state);

            if (!response) {
                elizaLogger.log('No response to send');
                return null;
            }

            return { text: response };
        } catch (error) {
            elizaLogger.error('Error handling message:', {
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

        elizaLogger.log('Creating memory:', {
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

    private updateChannelActivity(channel: TextChannel): void {
        const channelName = channel.name;
        const activity = this.groupActivities.get(channelName);
        if (activity) {
            activity.recentMessages.push({ isUser: true, time: Date.now() });
        }
    }

    private resetChannelCounters(channel: TextChannel): void {
        const channelName = channel.name;
        this.lastMarketingTimes.set(channelName, Date.now());
    }

    private isGroupActive(channelId: string): boolean {
        const activity = this.groupActivities.get(channelId);
        if (!activity) return false;

        const now = Date.now();
        // Only count messages within activity window
        const recentUserMessages = activity.recentMessages.filter(msg => 
            msg.isUser && (now - msg.time) < MARKETING_CONSTANTS.MESSAGE_ACTIVITY_WINDOW
        );

        return recentUserMessages.length >= MARKETING_CONSTANTS.REQUIRED_MESSAGES;
    }

    private async canSendMarketingMessage(channelName: string, channel: TextChannel): Promise<boolean> {
        try {
            const activity = this.groupActivities.get(channelName);
            if (!activity) {
                elizaLogger.log(`No activity tracking for ${channelName}`);
                return false;
            }

            const now = Date.now();
            
            // Reset daily count if it's a new day (24 hours since last reset)
            if (now - activity.lastDailyReset >= 24 * 60 * 60 * 1000) {
                activity.dailyMarketingCount = 0;
                activity.lastDailyReset = now;
                elizaLogger.log(`Reset daily marketing count for ${channelName}`);
            }

            const timeSinceLastMarketing = now - activity.lastMarketingTime;
            const minTimeElapsed = timeSinceLastMarketing >= MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL;

            // Check if the last message was from us
            const lastMessage = (await channel.messages.fetch({ limit: 1 })).first();
            const lastMessageWasMarketing = lastMessage?.author.id === this.client.getUserId();

            // Get user messages since marketing
            const userMessagesSinceMarketing = activity.recentMessages.filter(msg => 
                msg.isUser && msg.time > activity.lastMarketingTime
            ).length;

            const isActive = this.isGroupActive(channelName);

            // Log all conditions
            elizaLogger.log(`Marketing check details for ${channelName}:`, {
                timeSinceLastMarketing: Math.floor(timeSinceLastMarketing / (60 * 1000)),
                dailyMarketingCount: activity.dailyMarketingCount,
                lastMessageWasMarketing,
                userMessagesSinceMarketing,
                isActive,
                minTimeElapsed,
                marketingInterval: Math.floor(MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL / (60 * 1000)),
                maxMessagesPerDay: MARKETING_CONSTANTS.MAX_MESSAGES_PER_DAY,
                requiredMessages: MARKETING_CONSTANTS.REQUIRED_MESSAGES,
                userId: this.client.getUserId(),
                lastMessageAuthorId: lastMessage?.author.id,
                lastMessageTimestamp: lastMessage?.createdTimestamp,
                activityLastMarketingTime: activity.lastMarketingTime,
                recentMessagesCount: activity.recentMessages.length,
                timeSinceLastReset: Math.floor((now - activity.lastDailyReset) / (60 * 60 * 1000))
            });

            // Check each condition separately
            const timeCondition = minTimeElapsed;
            const messageCountCondition = activity.dailyMarketingCount < MARKETING_CONSTANTS.MAX_MESSAGES_PER_DAY;
            const activityCondition = isActive || (!lastMessageWasMarketing && timeSinceLastMarketing >= MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL);

            elizaLogger.log(`Marketing conditions for ${channelName}:`, {
                timeCondition,
                messageCountCondition,
                activityCondition
            });

            const canSend = timeCondition && messageCountCondition && activityCondition;

            if (!canSend) {
                if (!timeCondition) {
                    elizaLogger.log(`Cannot send: Minimum time (${Math.floor(MARKETING_CONSTANTS.MIN_MARKETING_INTERVAL / (60 * 1000))} minutes) has not elapsed`);
                }
                if (!messageCountCondition) {
                    elizaLogger.log(`Cannot send: Daily limit (${MARKETING_CONSTANTS.MAX_MESSAGES_PER_DAY} messages) reached. Current count: ${activity.dailyMarketingCount}`);
                }
                if (!activityCondition) {
                    if (!isActive) {
                        elizaLogger.log('Cannot send: Group is inactive');
                    }
                    if (lastMessageWasMarketing) {
                        elizaLogger.log('Cannot send: Last message was marketing');
                    }
                }
            }

            return canSend;
        } catch (error) {
            elizaLogger.error('Error checking marketing conditions:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                channelName
            });
            return false;
        }
    }

    async generateMarketingMessage(): Promise<string | null> {
        try {
            elizaLogger.log('Attempting to generate marketing message');

            const state = {
                character: this.runtime.character,
                agentName: this.runtime.character?.name || 'Agent',
                bio: this.runtime.character?.description || '',
                style: this.runtime.character?.style || {},
                topics: this.runtime.character?.topics || [],
                knowledge: this.runtime.character?.knowledge || [],
                lore: this.runtime.character?.lore || '',
                lastMessage: '',
                prompt: {
                    text: 'Generate a casual, natural marketing message that sounds like a genuine person sharing their experience.',
                    type: 'marketing'
                }
            };

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: discordMarketingTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            if (typeof response === 'string') {
                return response;
            } else if (typeof response === 'object' && response.text) {
                return String(response.text);
            }

            elizaLogger.warn('Invalid response format:', response);
            return null;
        } catch (error) {
            elizaLogger.error('Error generating marketing message:', {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }
}
