import { 
  Client, 
  Events, 
  GatewayIntentBits,
  ChatInputCommandInteraction
} from 'discord.js';
import { config as dotenvConfig } from 'dotenv';
import { parse } from 'toml';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';
import path from 'path';

import { Config } from './types/config';
import { Logger } from './utils/logger';
import { PoolMonitorService } from './services/PoolMonitorService';
import * as balanceCommand from './commands/balance';

dotenvConfig();

const requiredEnvVars = ['DISCORD_TOKEN', 'RPC_URL', 'PRIVATE_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`${envVar} is not defined in environment variables`);
  }
}

async function main() {
  try {
    const configPath = path.join(process.cwd(), 'config', 'config.toml');
    const config = parse(readFileSync(configPath, 'utf-8')) as Config;
    
    const client = new Client({ 
      intents: [GatewayIntentBits.Guilds],
      presence: {
        activities: [],
        status: 'online'
      }
    });

    const logger = new Logger(config, client);
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    
    logger.info('Starting application', {
      nodeEnv: process.env.NODE_ENV,
      configPath
    });
    
    const poolMonitor = new PoolMonitorService(config, logger, provider);

    client.once(Events.ClientReady, (readyClient) => {
      logger.info('Discord bot is ready!', {
        username: readyClient.user.tag
      });
      
      poolMonitor.startMonitoring().catch(error => {
        logger.error('Failed to start pool monitoring', { 
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });
    });

    client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand()) return;

      try {
        switch (interaction.commandName) {
          case 'balance': {
            await balanceCommand.execute(
              interaction as ChatInputCommandInteraction,
              config,
              logger,
              provider
            );
            break;
          }
          default: {
            logger.warn('Unknown command received', {
              commandName: interaction.commandName
            });
            await interaction.reply({
              content: 'Unknown command',
              ephemeral: true
            });
          }
        }
      } catch (error) {
        logger.error('Error handling command', {
          command: interaction.commandName,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'An error occurred while processing the command.',
              ephemeral: true
            });
          } else if (interaction.deferred) {
            await interaction.editReply('An error occurred while processing the command.');
          }
        } catch (replyError) {
          logger.error('Failed to send error response to Discord', {
            originalError: error instanceof Error ? error.message : 'Unknown error',
            replyError: replyError instanceof Error ? replyError.message : 'Unknown error'
          });
        }
      }
    });

    const commands = [balanceCommand.data.toJSON()];
    
    try {
      await client.login(process.env.DISCORD_TOKEN);
      
      if (!client.application) {
        throw new Error('Client application is not ready');
      }
      
      await client.application.commands.set(commands);
      logger.info('Slash commands registered successfully');
    } catch (error) {
      logger.error('Error during bot initialization', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }

    const shutdown = async () => {
      logger.info('Application shutdown initiated');
      await poolMonitor.stopMonitoring();
      client.destroy();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception', { 
        error: error.message,
        stack: error.stack
      });
      await shutdown().catch(err => {
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
    });

    process.on('unhandledRejection', async (error) => {
      logger.error('Unhandled rejection', { 
        error: error instanceof Error ? error.message : 'Unknown promise rejection',
        stack: error instanceof Error ? error.stack : undefined
      });
      await shutdown().catch(err => {
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
    });

  } catch (error) {
    console.error('Fatal error during startup:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});