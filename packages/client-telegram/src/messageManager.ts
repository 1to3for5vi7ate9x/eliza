import { elizaLogger, ServiceType, composeRandomUser } from "@elizaos/core";
import { getEmbeddingZeroVector } from "@elizaos/core";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    ModelClass,
    State,
    UUID,
    Media,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { generateMessageResponse, generateShouldRespond } from "@elizaos/core";
import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";
import { cosineSimilarity, escapeMarkdown } from "./utils";
import {
    MESSAGE_CONSTANTS,
    TIMING_CONSTANTS,
    RESPONSE_CHANCES,
} from "./constants";

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
            messages: { userId: UUID; userName: string; content: Content }[];
            contextSimilarityThreshold?: number;
        };
    } = {};

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log('Initializing MessageManager');
        this.runtime = runtime;
    }

    async handleMessage(message: Message): Promise<Content | null> {
        try {
            elizaLogger.log('Processing message:', message);

            // Create memory for the message
            const memory = await this.createMessageMemory(message);
            elizaLogger.log('Created memory:', memory);
            
            // Get state with message context
            const state = await this.runtime.composeState(memory);
            elizaLogger.log('Composed state');
            
            // Use AI to decide whether to respond
            const shouldRespondContext = this.composeResponseContext(state);
            elizaLogger.log('Composed response context');
            
            const shouldRespond = await this.shouldRespondToMessage(shouldRespondContext);
            elizaLogger.log('Should respond decision:', shouldRespond);

            if (shouldRespond !== 'RESPOND') {
                elizaLogger.log('Decided not to respond');
                return null;
            }

            // Generate response using character's personality
            const messageContext = this.composeMessageContext(state);
            elizaLogger.log('Composed message context');
            
            const response = await this.generateResponse(messageContext);
            elizaLogger.log('Generated response:', response);

            if (!response) {
                elizaLogger.error('Failed to generate response');
                return null;
            }

            // Update chat state
            this.updateChatState(message, response);
            elizaLogger.log('Updated chat state');

            return { text: response };
        } catch (error) {
            elizaLogger.error('Error handling message:', error);
            if (error instanceof Error) {
                elizaLogger.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
            }
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

    private composeResponseContext(state: State): string {
        try {
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.telegramShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    composeRandomUser(shouldRespondFooter, 2),
            });
            elizaLogger.log('Response context composed');
            return context;
        } catch (error) {
            elizaLogger.error('Error composing response context:', error);
            throw error;
        }
    }

    private async shouldRespondToMessage(context: string): Promise<string> {
        try {
            const response = await generateShouldRespond({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });
            elizaLogger.log('Should respond decision made:', response);
            return response;
        } catch (error) {
            elizaLogger.error('Error in shouldRespondToMessage:', error);
            throw error;
        }
    }

    private composeMessageContext(state: State): string {
        try {
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.telegramMessageHandlerTemplate ||
                    this.runtime.character?.templates?.messageHandlerTemplate ||
                    composeRandomUser(messageCompletionFooter, 2),
            });
            elizaLogger.log('Message context composed');
            return context;
        } catch (error) {
            elizaLogger.error('Error composing message context:', error);
            throw error;
        }
    }

    private async generateResponse(context: string): Promise<string> {
        try {
            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });
            elizaLogger.log('Response generated:', response ? 'success' : 'null');
            return response;
        } catch (error) {
            elizaLogger.error('Error generating response:', error);
            throw error;
        }
    }

    private updateChatState(message: Message, response: string): void {
        try {
            const chatId = message.chat.id;
            if (!this.interestChats[chatId]) {
                this.interestChats[chatId] = {
                    lastMessageSent: Date.now(),
                    messages: [],
                    contextSimilarityThreshold: MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD,
                };
            }

            const chatState = this.interestChats[chatId];
            chatState.messages.push({
                userId: stringToUuid(message.from.id),
                userName: message.from.username,
                content: { text: response },
            });

            // Keep only recent messages
            if (chatState.messages.length > MESSAGE_CONSTANTS.CHAT_HISTORY_COUNT) {
                chatState.messages = chatState.messages.slice(-MESSAGE_CONSTANTS.CHAT_HISTORY_COUNT);
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
