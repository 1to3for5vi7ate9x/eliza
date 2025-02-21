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
    private firstMarketingSent: Map<string, boolean> = new Map();
    private readonly MIN_MARKETING_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    private readonly MAX_MARKETING_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
    private readonly MIN_MESSAGES_FOR_ACTIVE = 5; // Minimum messages to consider a group active
    private readonly DEAD_GROUP_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours without messages marks a dead group
    private readonly MAX_MARKETING_MESSAGES_PER_CHANNEL = 4; // Max messages per channel per day
    private marketingEnabled: boolean = false;
    private isProcessingMarketing: Map<string, boolean> = new Map();

    constructor(runtime: IAgentRuntime, client: DiscordUserClient) {
        elizaLogger.log('Initializing Discord MessageManager');
        this.runtime = runtime;
        this.client = client;
    }

    async startMarketing(): Promise<void> {
        try {
            elizaLogger.log('🚀 Starting marketing initialization...');

            // Use existing DISCORD_ALLOWED_CHANNELS setting
            const allowedChannelsStr = this.runtime.getSetting('DISCORD_ALLOWED_CHANNELS');
            if (!allowedChannelsStr) {
                elizaLogger.warn('No marketing channels specified in DISCORD_ALLOWED_CHANNELS');
                return;
            }

            // Initialize target channels
            this.targetChannels = new Set(
                allowedChannelsStr.split(',')
                    .map(c => c.trim().toLowerCase())
                    .filter(c => c)
            );
            elizaLogger.log('Marketing channels initialized:', Array.from(this.targetChannels));

            // Enable marketing before initialization
            this.marketingEnabled = true;

            // Initialize marketing for each channel
            elizaLogger.log('Starting channel marketing initialization...');
            await this.initializeChannelMarketing();

            elizaLogger.log('✅ Marketing functionality started successfully');
        } catch (error) {
            elizaLogger.error('Failed to start marketing:', error);
            throw error;
        }
    }

    private async initializeChannelMarketing(): Promise<void> {
        try {
            const channels = await this.client.getChannels();
            elizaLogger.log(`Found ${channels.length} total channels`);

            for (const channelName of this.targetChannels) {
                try {
                    elizaLogger.log(`Looking for marketing channel: ${channelName}`);
                    const channel = channels.find(c => c.name.toLowerCase() === channelName.toLowerCase());

                    if (channel && channel instanceof TextChannel) {
                        elizaLogger.log(`Found marketing channel ${channelName} with ID: ${channel.id}`);

                        // Initialize channel state
                        this.lastMarketingTimes.set(channel.name, 0);
                        this.channelMessageCounts.set(channel.name, 0);
                        this.channelTimeReductions.set(channel.name, 0);
                        this.firstMarketingSent.set(channel.name, false);

                        // Schedule first marketing message with a random delay between MIN and MAX interval
                        const delay = this.MIN_MARKETING_INTERVAL;
                        elizaLogger.log(`⏰ Scheduling first marketing message for ${channelName} in ${delay/1000} seconds`);

                        setTimeout(() => {
                            if (this.marketingEnabled) {
                                elizaLogger.log(`⏰ Initial timer triggered for ${channelName}`);
                                this.sendMarketingMessage(channel).catch(error => {
                                    elizaLogger.error(`Error in initial marketing message for ${channelName}:`, error);
                                });
                            }
                        }, delay);

                        elizaLogger.log(`✅ Initialized marketing for ${channelName}`);
                    } else {
                        elizaLogger.warn(`⚠️ Could not find marketing channel: ${channelName}`);
                    }
                } catch (error) {
                    elizaLogger.error(`Failed to initialize marketing for channel ${channelName}:`, error);
                }
            }
        } catch (error) {
            elizaLogger.error('Error in initializeChannelMarketing:', error);
            throw error;
        }
    }

    async stopMarketing(): Promise<void> {
        elizaLogger.log('Stopping Discord marketing...');
        this.marketingEnabled = false;
    }

    async sendMarketingMessage(channel: TextChannel): Promise<void> {
        const channelName = channel.name;

        // Check if we're already processing a marketing message for this channel
        if (this.isProcessingMarketing.get(channelName)) {
            elizaLogger.debug(`Already processing marketing for ${channelName}, skipping`);
            return;
        }

        try {
            this.isProcessingMarketing.set(channelName, true);

            // Check if the group is dead (no activity for 24 hours)
            const lastActivity = this.channelTimeReductions.get(channelName) || 0;
            const now = Date.now();
            const isDeadGroup = (now - lastActivity) >= this.DEAD_GROUP_THRESHOLD;

            if (isDeadGroup) {
                elizaLogger.log(`Skipping marketing for dead group: ${channelName}`);
                return;
            }

            // Set flags BEFORE generating message to prevent race conditions
            this.lastMarketingTimes.set(channelName, now);
            this.firstMarketingSent.set(channelName, true);

            // Generate and send the marketing message
            const message = await this.generateMarketingMessage(channel);
            if (message) {
                elizaLogger.log(`📨 Sending marketing message to ${channelName}: ${message}`);
                await this.client.sendMessage(channel.id, { message });
                elizaLogger.log(`✅ Successfully sent marketing message to ${channelName}`);
            }
        } catch (error) {
            elizaLogger.error('Error in marketing message flow:', {
                error: error instanceof Error ? error.message : String(error),
                channelName,
                channelId: channel.id
            });
            // Reset flags if message sending failed
            this.lastMarketingTimes.delete(channelName);
            this.firstMarketingSent.delete(channelName);
        } finally {
            this.isProcessingMarketing.set(channelName, false);
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
            // Skip messages from the bot itself
            const botId = this.client.getUserId();
            if (message.author.id === botId) {
                return null;
            }

            elizaLogger.log('🔄 Starting message processing:', {
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

    private updateChannelActivity(channel: TextChannel): void {
        const channelName = channel.name;

        // Skip if already processing marketing for this channel
        if (this.isProcessingMarketing.get(channelName)) {
            return;
        }

        const currentCount = this.channelMessageCounts.get(channelName) || 0;
        this.channelMessageCounts.set(channelName, currentCount + 1);

        // Update last activity time
        this.channelTimeReductions.set(channelName, Date.now());

        // Only proceed if marketing is enabled
        if (!this.marketingEnabled) return;

        const now = Date.now();
        const lastMarketingTime = this.lastMarketingTimes.get(channelName) || 0;
        const timeSinceLastMarketing = now - lastMarketingTime;
        const hasFirstMessageBeenSent = this.firstMarketingSent.get(channelName) || false;

        // If we've sent a marketing message in the last 6 hours, don't send another one
        if (lastMarketingTime > 0 && timeSinceLastMarketing < this.MIN_MARKETING_INTERVAL) {
            elizaLogger.debug(`Skipping marketing for ${channelName}, last message was ${Math.floor(timeSinceLastMarketing / (60 * 60 * 1000))} hours ago`);
            return;
        }

        // For new active groups (5+ messages and no first message sent), send first message
        if (currentCount + 1 >= this.MIN_MESSAGES_FOR_ACTIVE && !hasFirstMessageBeenSent) {
            elizaLogger.log(`Group ${channelName} is active, sending first marketing message. Messages: ${currentCount + 1}`);
            this.sendMarketingMessage(channel).catch(error => {
                elizaLogger.error(`Error sending marketing message for ${channelName}:`, error);
            });
            return;
        }

        // For any group that hasn't received a message in 6+ hours, send a message
        if (hasFirstMessageBeenSent && timeSinceLastMarketing >= this.MIN_MARKETING_INTERVAL) {
            const lastActivity = this.channelTimeReductions.get(channelName) || 0;
            const isDeadGroup = (now - lastActivity) >= this.DEAD_GROUP_THRESHOLD;
            
            if (!isDeadGroup) {
                elizaLogger.log(`Marketing interval passed for ${channelName}, sending message. Hours since last: ${Math.floor(timeSinceLastMarketing / (60 * 60 * 1000))}`);
                this.sendMarketingMessage(channel).catch(error => {
                    elizaLogger.error(`Error sending marketing message for ${channelName}:`, error);
                });
            }
        }
    }

    private resetChannelCounters(channel: TextChannel): void {
        const channelName = channel.name;
        this.lastMarketingTimes.set(channelName, Date.now());
        this.channelMessageCounts.set(channelName, 0);
    }

    private async generateMarketingMessage(channel: TextChannel): Promise<string | null> {
        try {
            // Check if character and marketing template exist
            if (!this.runtime.character?.templates?.discordMarketingTemplate) {
                elizaLogger.error('Marketing template not found in character file');
                return null;
            }

            elizaLogger.log('Attempting to generate marketing message with:', {
                character: this.runtime.character?.name,
                hasStyle: !!this.runtime.character?.style,
                hasTopics: !!this.runtime.character?.topics,
                hasKnowledge: !!this.runtime.character?.knowledge,
                system: this.runtime.character?.system
            });

            // Combine character's system prompt with state
            const state: State = {
                character: {
                    name: this.runtime.character?.name || '',
                    bio: Array.isArray(this.runtime.character?.bio) ? this.runtime.character.bio.join('\n') : this.runtime.character?.bio || '',
                    lore: Array.isArray(this.runtime.character?.lore) ? this.runtime.character.lore.join('\n') : this.runtime.character?.lore || '',
                    topics: Array.isArray(this.runtime.character?.topics) ? this.runtime.character.topics.join('\n') : this.runtime.character?.topics || '',
                    knowledge: Array.isArray(this.runtime.character?.knowledge) ? this.runtime.character.knowledge.join('\n') : this.runtime.character?.knowledge || '',
                    style: this.runtime.character?.style || {},
                    system: this.runtime.character?.system || ''
                },
                currentMessage: '',
                agentName: this.runtime.character?.name || '',
                username: '',
                context: '',
                // Add style guidelines explicitly
                personality: Array.isArray(this.runtime.character?.style?.personality) 
                    ? this.runtime.character.style.personality.join('\n') 
                    : '',
                avoid: Array.isArray(this.runtime.character?.style?.avoid)
                    ? this.runtime.character.style.avoid.join('\n')
                    : ''
            };

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character.templates.discordMarketingTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            if (!response) {
                elizaLogger.warn('No marketing message generated');
                return null;
            }

            let messageText: string;
            if (typeof response === 'string') {
                // Try to parse as JSON if it's a string
                try {
                    const parsedResponse = JSON.parse(response);
                    messageText = parsedResponse.text;
                } catch (e) {
                    // If parsing fails, use the string directly
                    messageText = response;
                }
            } else {
                messageText = response.text;
            }

            if (!messageText) {
                elizaLogger.warn('Empty marketing message text');
                return null;
            }

            // Validate message against character's avoid guidelines
            const avoidGuidelines = this.runtime.character?.style?.avoid || [];
            const violatesGuidelines = avoidGuidelines.some(guideline => 
                messageText.toLowerCase().includes(guideline.toLowerCase())
            );

            if (violatesGuidelines) {
                elizaLogger.warn('Generated message violates character guidelines');
                return null;
            }

            elizaLogger.log('Generated marketing message:', messageText);
            return messageText;

        } catch (error) {
            elizaLogger.error('Error generating marketing message:', {
                error: error instanceof Error ? error.message : String(error),
                channelName: channel.name
            });
            return null;
        }
    }
}
