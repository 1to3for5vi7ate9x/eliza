import {
    Content,
    Memory,
    elizaLogger,
    IAgentRuntime,
    generateMessageResponse,
    generateShouldRespond
} from '@elizaos/core';

export interface DiscordMessage {
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

    async handleMessage(message: DiscordMessage): Promise<Content | null> {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const userName = message.from.username;

        // Initialize chat state if not exists
        if (!this.interestChats[chatId]) {
            this.interestChats[chatId] = {
                lastMessageSent: 0,
                messages: []
            };
        }

        // Create memory from message
        const memory = await this.createMessageMemory(message);

        // Check if we should respond
        const shouldRespond = await generateShouldRespond(
            this.runtime,
            memory,
            message.text
        );

        if (!shouldRespond) {
            elizaLogger.log('Decided not to respond to message');
            return null;
        }

        // Generate response
        const response = await generateMessageResponse(
            this.runtime,
            memory,
            message.text
        );

        if (response) {
            this.updateChatState(message, response);
        }

        return response;
    }

    private async createMessageMemory(message: DiscordMessage): Promise<Memory> {
        const chatId = message.chat.id;
        const chatState = this.interestChats[chatId];
        
        return {
            id: `${message.from.id}-${Date.now()}`,
            timestamp: Date.now(),
            type: 'message',
            content: message.text,
            metadata: {
                platform: 'discord',
                channelId: chatId,
                messageId: message.replyTo?.messageId,
                userId: message.from.id,
                username: message.from.username,
                messageType: message.chat.type,
                context: chatState?.messages || []
            }
        };
    }

    private updateChatState(message: DiscordMessage, response: string): void {
        const chatId = message.chat.id;
        const chatState = this.interestChats[chatId];
        
        // Add user message
        chatState.messages.push({
            userId: message.from.id,
            userName: message.from.username,
            content: message.text
        });

        // Add bot response
        chatState.messages.push({
            userId: 'bot',
            userName: this.runtime.character?.name || 'Bot',
            content: response
        });

        // Update last message time
        chatState.lastMessageSent = Date.now();

        // Trim context if too long
        const maxContextLength = 10;
        if (chatState.messages.length > maxContextLength) {
            chatState.messages = chatState.messages.slice(-maxContextLength);
        }
    }
}
