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

Recent interactions:
{{recentPostInteractions}}

# TASK: Generate a response as {{agentName}}

Current Message:
{{currentPost}}

Previous Messages:
{{formattedConversation}}

# INSTRUCTIONS:
1. First, understand the exact question or topic the user is asking about
2. Provide a direct, concise answer that addresses the specific question
3. Keep responses short and natural, like a human conversation
4. Stay strictly on topic - only add relevant context if necessary
5. Use a friendly but professional tone
6. Avoid asking unnecessary questions
7. If the question is about your knowledge in a topic, first confirm if you know it, then offer to share specific aspects

Remember:
- Keep responses under 2-3 sentences
- Answer the question first, then add minimal context if needed
- Stay focused on the user's specific question
- Use natural, conversational language
- Be direct and clear
` + messageCompletionFooter;

// Should respond template for Telegram
export const telegramShouldRespondTemplate = `
# INSTRUCTIONS: Determine if {{agentName}} should respond to the message.

Response options are [RESPOND], [IGNORE] and [STOP].

For messages:
- RESPOND to direct questions
- RESPOND to messages about crypto, blockchain, AI, or technology
- RESPOND if someone is seeking advice in your areas of expertise
- IGNORE messages that are completely off-topic (not about tech, crypto, AI, or related fields)
- IGNORE spam or nonsense messages
- STOP if asked to stop or if conversation is clearly ended

IMPORTANT:
- If the message is even slightly related to your expertise, choose RESPOND
- Only IGNORE messages that are completely unrelated to your knowledge areas
- When in doubt about relevance, choose RESPOND

Recent Messages:
{{recentPosts}}

Current message for analysis:
{{currentPost}}
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
                elizaLogger.error('❌ Failed to create message memory:', error);
                throw new Error('Memory creation failed');
            }

            // Get state with message context and chat history
            let state: State;
            try {
                state = await this.runtime.composeState(memory);
                
                // Add recent chat history to state
                const chatId = message.chat.id;
                if (this.interestChats[chatId]) {
                    const recentMessages = this.interestChats[chatId].messages
                        .slice(-5) // Get last 5 messages
                        .map(msg => `${msg.userName}: ${msg.content.text}`)
                        .join('\n');
                    state.context = `Recent chat history:\n${recentMessages}\n\nCurrent message:\n${message.from.username}: ${message.text}`;
                } else {
                    state.context = `Current message:\n${message.from.username}: ${message.text}`;
                }
                
                elizaLogger.log('✅ State composed successfully with chat history');
            } catch (error) {
                elizaLogger.error('❌ Failed to compose state:', error);
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
                    modelClass: ModelClass.LARGE
                });
                elizaLogger.log('🤔 Response decision:', shouldRespond);
            } catch (error) {
                elizaLogger.error('❌ Failed to determine if should respond:', error);
                throw new Error('Response decision failed');
            }

            if (shouldRespond !== 'RESPOND') {
                elizaLogger.log('⏭️ Decided not to respond');
                return null;
            }

            // Generate response using character's personality
            let response: string;
            try {
                const messageContext = `
# Current Conversation
User ${message.from.username} asks: ${message.text}

# Chat History
${this.interestChats[message.chat.id]?.messages
    .slice(-5)
    .map(msg => `${msg.userName}: ${msg.content.text}`)
    .join('\n') || 'No previous messages'}

# Task
Generate a natural, conversational response to the user's message that:
1. Directly addresses their question about Bitcoin
2. Shows expertise without being overly technical
3. Maintains a friendly, helpful tone
4. Keeps the response concise (2-3 sentences)

${this.runtime.character?.templates?.telegramMessageHandlerTemplate ||
  this.runtime.character?.templates?.messageHandlerTemplate ||
  telegramMessageHandlerTemplate}`;

                elizaLogger.log('📝 Message context composed:', messageContext);
                
                response = await generateMessageResponse({
                    runtime: this.runtime,
                    context: messageContext,
                    modelClass: ModelClass.LARGE
                });

                // Parse JSON response if needed
                try {
                    const jsonResponse = JSON.parse(response);
                    response = jsonResponse.text || response;
                } catch (e) {
                    // If not JSON, use response as is
                }

                elizaLogger.log('✅ Raw response generated:', response);

            } catch (error) {
                elizaLogger.error('❌ Failed to generate response:', error);
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
                elizaLogger.error('❌ Failed to update chat state:', error);
            }

            elizaLogger.success('✨ Message handled successfully');
            return { text: response };
        } catch (error) {
            elizaLogger.error('❌ Critical error in handleMessage:', error);
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
