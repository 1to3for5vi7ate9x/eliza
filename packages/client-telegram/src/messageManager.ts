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

# Current Conversation Context
Previous messages:
{{context}}

# Current Question/Message
User {{username}} asks: {{currentMessage}}

# Task
Generate a natural, conversational response that:
1. Directly addresses the user's specific question/message
2. Shows expertise without being overly technical
3. Maintains a friendly, helpful tone
4. Keeps the response concise (2-3 sentences)
5. Stays focused on the current topic
` + messageCompletionFooter;

// Should respond template for Telegram
export const telegramShouldRespondTemplate = `
# Character Context
Name: {{agentName}}
Role: {{description}}

# Conversation State
Previous messages:
{{context}}

Current message from user {{username}}: {{currentMessage}}

# Task
Determine if {{agentName}} should respond to this message. Consider:
1. Is the message relevant to {{agentName}}'s expertise?
2. Is it a direct question or comment that warrants a response?
3. Has {{agentName}} already answered a similar question recently?

Respond with one of:
- RESPOND: If the message deserves a response
- IGNORE: If the message is irrelevant or doesn't need a response
- STOP: If the conversation should end
` + shouldRespondFooter;

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

            // Validate message
            if (!message.from.id || !message.chat.id) {
                throw new Error('Invalid message format: Missing required fields');
            }

            // Ensure message text is properly formatted
            message.text = typeof message.text === 'object' ? 
                JSON.stringify(message.text) : String(message.text || '');

            // Create memory for the message
            let memory = await this.createMessageMemory(message);

            // Compose state with chat history
            let state = await this.runtime.composeState(memory);
            const chatId = message.chat.id;
            
            // Add chat history context
            if (this.interestChats[chatId]) {
                const recentMessages = this.interestChats[chatId].messages
                    .slice(-5)
                    .map(msg => `${msg.userName}: ${msg.content.text}`)
                    .join('\n');
                    
                state.context = `Recent conversation:\n${recentMessages}`;
            }

            // Add current message and user info
            state.currentMessage = message.text;
            state.username = message.from.username || 'User';

            // Add character context
            state.character = {
                name: this.runtime.character.name,
                description: this.runtime.character.description,
                topics: this.runtime.character.topics,
                knowledge: this.runtime.character.knowledge
            };

            // Use AI to decide whether to respond
            let shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramShouldRespondTemplate || telegramShouldRespondTemplate
                }),
                modelClass: ModelClass.LARGE
            });

            elizaLogger.log('🤔 Should respond decision:', {
                decision: shouldRespond,
                message: message.text
            });

            if (shouldRespond !== 'RESPOND') {
                elizaLogger.log('Decided not to respond', {
                    reason: shouldRespond,
                    message: message.text
                });
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
                userId: stringToUuid(message.from.id),
                roomId: stringToUuid(message.chat.id + "-" + this.runtime.agentId),
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
                userId: message.from?.id,
                chatId: message.chat?.id,
                character: this.runtime.character?.name
            });
            return null;
        }
    }

    private async createMessageMemory(message: Message): Promise<Memory> {
        try {
            const userId = stringToUuid(message.from.id);
            const roomId = stringToUuid(message.chat.id + "-" + this.runtime.agentId);
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
                message.from.username || '',
                message.from.firstName || '',
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
                userId: message.from.id,
                chatId: message.chat.id
            });
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

            // Ensure message content is properly formatted
            const messageText = typeof message.text === 'object' ? 
                JSON.stringify(message.text) : String(message.text || '');

            // Add message to chat history with proper content structure
            this.interestChats[chatId].messages.push({
                userId: message.from.id,
                userName: message.from.username || message.from.firstName || 'Unknown',
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
                chatId: message.chat.id
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
}
