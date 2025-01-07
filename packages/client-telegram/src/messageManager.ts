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
# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions:
{{recentPostInteractions}}

# TASK: Generate a response in the voice, style and perspective of {{agentName}} while using the conversation history as context:

Current Message:
{{currentPost}}

Previous Messages:
{{formattedConversation}}

# INSTRUCTIONS: Generate a response in the voice, style and perspective of {{agentName}}. Stay in character at all times.
` + messageCompletionFooter;

// Should respond template for Telegram
export const telegramShouldRespondTemplate = `
# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation.

Response options are [RESPOND], [IGNORE] and [STOP].

For messages:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a chat room and wants to be conversational, but not annoying

IMPORTANT:
- {{agentName}} is sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND
- {{agentName}} should err on the side of IGNORE rather than RESPOND if in doubt

Recent Messages:
{{recentPosts}}

Current Message:
{{currentPost}}

Previous Messages:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
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

            // Create memory for the message
            let memory: Memory;
            try {
                memory = await this.createMessageMemory(message);
                elizaLogger.log('✅ Memory created successfully:', memory);
            } catch (error) {
                elizaLogger.error('❌ Failed to create message memory:', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    stack: error instanceof Error ? error.stack : undefined
                });
                throw new Error('Memory creation failed');
            }

            // Get state with message context
            let state: State;
            try {
                state = await this.runtime.composeState(memory);
                elizaLogger.log('✅ State composed successfully');
            } catch (error) {
                elizaLogger.error('❌ Failed to compose state:', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    stack: error instanceof Error ? error.stack : undefined
                });
                throw new Error('State composition failed');
            }

            // Use AI to decide whether to respond
            let shouldRespond: string;
            try {
                const shouldRespondContext = composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramShouldRespondTemplate || 
                             this.runtime.character?.templates?.shouldRespondTemplate || 
                             telegramShouldRespondTemplate
                });
                elizaLogger.log('📝 Response context composed:', shouldRespondContext);
                
                shouldRespond = await generateShouldRespond({
                    runtime: this.runtime,
                    context: shouldRespondContext,
                    modelClass: ModelClass.SMALL
                });
                elizaLogger.log('🤔 Response decision:', shouldRespond);
            } catch (error) {
                elizaLogger.error('❌ Failed to determine if should respond:', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    stack: error instanceof Error ? error.stack : undefined
                });
                throw new Error('Response decision failed');
            }

            if (shouldRespond !== 'RESPOND') {
                elizaLogger.log('⏭️ Decided not to respond');
                return null;
            }

            // Generate response using character's personality
            let response: string;
            try {
                // Get character's template and system prompt
                const messageContext = composeContext({
                    state,
                    template: this.runtime.character?.templates?.telegramMessageHandlerTemplate ||
                             this.runtime.character?.templates?.messageHandlerTemplate ||
                             telegramMessageHandlerTemplate
                });
                
                elizaLogger.log('📝 Message context composed:', messageContext);
                
                response = await generateMessageResponse({
                    runtime: this.runtime,
                    context: messageContext,
                    modelClass: ModelClass.MEDIUM
                });

                elizaLogger.log('✅ Raw response generated:', response);

            } catch (error) {
                elizaLogger.error('❌ Failed to generate response:', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    stack: error instanceof Error ? error.stack : undefined,
                    state: state
                });
                throw new Error('Response generation failed');
            }

            if (!response) {
                elizaLogger.error('❌ No response generated');
                return null;
            }

            // Update chat state
            try {
                this.updateChatState(message, response);
                elizaLogger.log('✅ Chat state updated successfully');
            } catch (error) {
                elizaLogger.error('❌ Failed to update chat state:', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    stack: error instanceof Error ? error.stack : undefined
                });
            }

            elizaLogger.success('✨ Message handled successfully');
            return { text: response };
        } catch (error) {
            elizaLogger.error('❌ Critical error in handleMessage:', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                message: message
            });
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
