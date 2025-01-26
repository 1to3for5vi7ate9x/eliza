import { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { MessageManager } from "./messageManager.ts";
import { getOrCreateRecommenderInBe } from "./getOrCreateRecommenderInBe.ts";

export class TelegramClient {
    private bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private backend;
    private backendToken;
    private tgTrader;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private readonly MAX_RECONNECT_ATTEMPTS: number = 10;
    private readonly RECONNECT_DELAY: number = 5000;
    private reconnectTimeout?: NodeJS.Timeout;

    constructor(runtime: IAgentRuntime, botToken: string) {
        elizaLogger.log("📱 Constructing new TelegramClient...");
        this.runtime = runtime;
        
        // Validate character configuration
        if (!this.runtime.character) {
            throw new Error("Character configuration is missing");
        }
        elizaLogger.log("✅ Loaded character:", {
            name: this.runtime.character.name,
            description: this.runtime.character.description
        });

        this.bot = new Telegraf(botToken);
        this.messageManager = new MessageManager(this.bot, this.runtime);
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.tgTrader = runtime.getSetting("TG_TRADER"); // boolean To Be added to the settings
        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupConnectionHandlers();
            this.setupShutdownHandlers();
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        try {
            await this.bot.launch({ dropPendingUpdates: true });
            this.isConnected = true;
            this.reconnectAttempts = 0;
            elizaLogger.log("✨ Telegram bot successfully launched and is running!");

            const botInfo = await this.bot.telegram.getMe();
            this.bot.botInfo = botInfo;
            elizaLogger.success(`Bot username: @${botInfo.username}`);

            this.messageManager.bot = this.bot;
        } catch (error) {
            elizaLogger.error("Failed to initialize bot:", error);
            await this.handleConnectionError();
        }
    }

    private async isGroupAuthorized(ctx: Context): Promise<boolean> {
        const config = this.runtime.character.clientConfig?.telegram;
        if (ctx.from?.id === ctx.botInfo?.id) {
            return false;
        }

        if (!config?.shouldOnlyJoinInAllowedGroups) {
            return true;
        }

        const allowedGroups = config.allowedGroupIds || [];
        const currentGroupId = ctx.chat.id.toString();

        if (!allowedGroups.includes(currentGroupId)) {
            elizaLogger.info(`Unauthorized group detected: ${currentGroupId}`);
            try {
                await ctx.reply("Not authorized. Leaving.");
                await ctx.leaveChat();
            } catch (error) {
                elizaLogger.error(
                    `Error leaving unauthorized group ${currentGroupId}:`,
                    error
                );
            }
            return false;
        }

        return true;
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handlers...");
        
        // Handle messages
        this.bot.on(message('text'), async (ctx) => {
            try {
                const msg = {
                    text: ctx.message.text,
                    from: {
                        id: ctx.message.from.id.toString(),
                        username: ctx.message.from.username,
                        firstName: ctx.message.from.first_name
                    },
                    chat: {
                        id: ctx.message.chat.id.toString(),
                        type: ctx.message.chat.type,
                        title: 'title' in ctx.message.chat ? ctx.message.chat.title : undefined
                    }
                };

                const response = await this.messageManager.handleMessage(msg);
                if (response && response.text) {
                    await ctx.reply(response.text);
                }
            } catch (error) {
                elizaLogger.error("Error handling message:", error);
            }
        });

        elizaLogger.log("✅ Message handlers setup complete");
    }

    private setupConnectionHandlers(): void {
        // Handle connection errors
        this.bot.catch((error: any) => {
            elizaLogger.error("Telegram bot error:", error);
            this.handleConnectionError();
        });

        // Handle webhook errors
        if (this.bot.telegram.webhookReply) {
            this.bot.telegram.webhook.on('error', (error: Error) => {
                elizaLogger.error("Webhook error:", error);
                this.handleConnectionError();
            });
        }
    }

    private async handleConnectionError(): Promise<void> {
        this.isConnected = false;
        elizaLogger.warn(`[Reconnect] Connection lost. Attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS}`);

        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            elizaLogger.error("Max reconnection attempts reached. Stopping bot.");
            await this.stop();
            return;
        }

        this.reconnectAttempts++;

        // Clear any existing reconnect timeout
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        // Set up reconnection with exponential backoff
        const delay = this.RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1);
        elizaLogger.info(`[Reconnect] Attempting to reconnect in ${delay}ms...`);

        this.reconnectTimeout = setTimeout(async () => {
            try {
                elizaLogger.info("[Reconnect] Closing current connection...");
                await this.bot.stop();
                
                elizaLogger.info("[Reconnect] Initializing new connection...");
                await this.initializeBot();
                
                if (this.isConnected) {
                    elizaLogger.success("[Reconnect] Successfully reconnected!");
                }
            } catch (error) {
                elizaLogger.error("[Reconnect] Failed to reconnect:", error);
                await this.handleConnectionError();
            }
        }, delay);
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    public async stop(): Promise<void> {
        elizaLogger.info("Stopping Telegram bot...");
        try {
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
            }
            await this.bot.stop();
            this.isConnected = false;
            elizaLogger.info("Telegram bot stopped successfully");
        } catch (error) {
            elizaLogger.error("Error stopping bot:", error);
        }
    }

    // Add method to get dialog by ID
    public async getDialogById(chatId: string | number) {
        try {
            const chat = await this.bot.telegram.getChat(chatId);
            if (!chat) {
                elizaLogger.warn(`Could not find chat with ID: ${chatId}`);
                return null;
            }
            return {
                id: chat.id.toString(),
                title: 'title' in chat ? chat.title : undefined,
                type: chat.type
            };
        } catch (error) {
            elizaLogger.error('Error getting chat by ID:', {
                error: error instanceof Error ? error.message : String(error),
                chatId
            });
            return null;
        }
    }
}
