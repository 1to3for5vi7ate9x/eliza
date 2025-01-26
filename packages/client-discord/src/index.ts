import { elizaLogger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import { DiscordUserClient } from './discordUserClient';

let client: DiscordUserClient | null = null;

export const DiscordClientInterface = {
    start: async (runtime: IAgentRuntime): Promise<DiscordUserClient> => {
        try {
            elizaLogger.log('Starting Discord client...');
            client = new DiscordUserClient(runtime);
            await client.start();
            return client;
        } catch (error) {
            elizaLogger.error('Failed to start Discord client:', error);
            throw error;
        }
    },
    stop: async (_runtime: IAgentRuntime): Promise<void> => {
        try {
            if (client) {
                await client.stop();
                client = null;
            }
        } catch (error) {
            elizaLogger.error('Failed to stop Discord client:', error);
            throw error;
        }
    }
};
