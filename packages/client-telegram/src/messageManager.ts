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

// Message handler template for Telegram
export const telegramMessageHandlerTemplate = `
# Character Context
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

# Current Conversation
User {{username}} asks: {{message}}

# Chat History
{{chatHistory}}

# Task
Generate a natural, conversational response that:
1. Directly addresses the user's message
2. Shows expertise without being overly technical
3. Maintains a friendly, helpful tone
4. Keeps the response concise (2-3 sentences)

${messageCompletionFooter}`;

// Should respond template for Telegram
export const telegramShouldRespondTemplate = `
# INSTRUCTIONS: Determine if {{agentName}} should respond to the message.

Response options are [RESPOND], [IGNORE] and [STOP].

For messages:
- RESPOND to direct questions
- RESPOND to messages about topics in character's expertise
- IGNORE messages that are completely off-topic
- IGNORE spam or nonsense messages
- STOP if asked to stop or if conversation is clearly ended

IMPORTANT:
- If the message is even slightly related to expertise, choose RESPOND
- Only IGNORE messages that are completely unrelated
- When in doubt about relevance, choose RESPOND

Recent Messages:
{{recentPosts}}

Current message:
{{currentPost}}

${shouldRespondFooter}`;

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
    private interestChats: {
        [key: string]: {
            lastMessageSent: number;
            messages: { userId: string; userName: string; content: Content }[];
            contextSimilarityThreshold?: number;
        };
    } = {};

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log('Initializing MessageManager');
        this.runtime = runtime;
    }

    async handleMessage(message: Message): Promise<Content | null> {
        try {
            elizaLogger.log('🔄 Starting message processing:', {
                text: message.text,
                chatId: message.chat.id,
                userId: message.from.id
            });

            // Create memory for the message
            let memory = await this.createMessageMemory({
                text: message.text,
                userId: message.from.id
            });

            // Compose state with chat history
            let state = await this.runtime.composeState(memory);
            const chatId = message.chat.id;
            if (this.interestChats[chatId]) {
                state.context = this.interestChats[chatId].messages
                    .slice(-5)
                    .map(msg => `${msg.userName}: ${msg.content.text}`)
                    .join('\n');
            } else {
                state.context = `Current message:\n${message.from.username}: ${message.text}`;
            }

            // Use AI to decide whether to respond
            let shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramShouldRespondTemplate || telegramShouldRespondTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            if (shouldRespond !== 'RESPOND') {
                elizaLogger.log('🤔 Decided not to respond');
                return null;
            }

            // Generate response using character's personality
            let response = await generateMessageResponse({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramMessageHandlerTemplate || telegramMessageHandlerTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            // Update chat state
            this.updateChatState(message, response);

            return { type: 'text', content: response };

        } catch (error) {
            elizaLogger.error('❌ Error handling message:', error);
            return null;
        }
    }

    private async createMessageMemory(message: Message): Promise<Memory> {
        try {
            const userId = stringToUuid(message.from.id);
            const roomId = stringToUuid(message.chat.id + "-" + this.runtime.agentId);

            const content: Content = {
                text: message.text,
                source: 'telegram',
                inReplyTo: message.replyTo ? stringToUuid(message.replyTo.messageId) : undefined
            };

            const memory: Memory = {
                id: stringToUuid(Date.now().toString()),
                agentId: this.runtime.agentId,
                userId,
                roomId,
                content,
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            await this.runtime.messageManager.createMemory(memory);
            elizaLogger.log('Memory created successfully:', { id: memory.id, userId, roomId });
            return memory;
        } catch (error) {
            elizaLogger.error('Error creating memory:', error);
            throw error;
        }
    }

    private updateChatState(message: Message, response: string): void {
        try {
            const chatId = message.chat.id;

            // Initialize chat state if not exists
            if (!this.interestChats[chatId]) {
                this.interestChats[chatId] = {
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            }

            // Update last message sent time
            this.interestChats[chatId].lastMessageSent = Date.now();

            // Add message to chat history
            this.interestChats[chatId].messages.push({
                userId: message.from.id,
                userName: message.from.username,
                content: { text: message.text }
            });

            // Add bot's response to chat history
            this.interestChats[chatId].messages.push({
                userId: this.runtime.agentId,
                userName: 'bot',
                content: { text: response }
            });

            // Keep only last N messages
            const maxMessages = 10;
            if (this.interestChats[chatId].messages.length > maxMessages) {
                this.interestChats[chatId].messages = this.interestChats[chatId].messages.slice(-maxMessages);
            }

            elizaLogger.log('Chat state updated for:', chatId);
        } catch (error) {
            elizaLogger.error('Error updating chat state:', error);
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
}
