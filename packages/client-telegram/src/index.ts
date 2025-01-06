import { elizaLogger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import { TelegramUserClient } from './telegramUserClient';

export interface TelegramClientInterface {
    start(runtime: IAgentRuntime): Promise<void>;
    stop(runtime: IAgentRuntime): Promise<void>;
}

let client: TelegramUserClient | null = null;

export async function start(runtime: IAgentRuntime): Promise<void> {
    try {
        elizaLogger.log('Starting Telegram client...');
        client = new TelegramUserClient(runtime);
        await client.start();
    } catch (error) {
        elizaLogger.error('Failed to start Telegram client:', error);
        throw error;
    }
}

export async function stop(_runtime: IAgentRuntime): Promise<void> {
    try {
        if (client) {
            await client.stop();
            client = null;
        }
    } catch (error) {
        elizaLogger.error('Failed to stop Telegram client:', error);
        throw error;
    }
}

export default { start, stop };
