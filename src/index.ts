import { Client, Events, GatewayIntentBits, ActivityType } from 'discord.js';
import { config as dotenvConfig } from 'dotenv';
import cron from 'node-cron';
import { parse } from 'toml';
import { readFileSync } from 'fs';

import { UniswapService } from './utils/uniswapService';
import { formatNumber } from './utils/formatNumber';
import * as balanceCommand from './commands/balance';
import { Config } from './types/config';

dotenvConfig();

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is not defined in environment variables');
}

if (!process.env.RPC_URL) {
  throw new Error('RPC_URL is not defined in environment variables');
}

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not defined in environment variables');
}

const config = parse(readFileSync('./src/config/config.toml', 'utf-8')) as Config;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const uniswapService = new UniswapService(process.env.RPC_URL, process.env.PRIVATE_KEY);

async function updateBotStatus(): Promise<void> {
  try {
    const balance = await uniswapService.getPoolBalance();
    await client.user?.setActivity(`WETH: ${formatNumber(balance, config.pool.decimal_places)}`, { type: ActivityType.Watching });
  } catch (error) {
    console.error('Error updating status:', error);
  }
}

client.once(Events.ClientReady, () => {
  console.log('Discord bot is ready!');
  updateBotStatus();
  
  cron.schedule(`*/${config.discord.status_update_interval} * * * *`, updateBotStatus);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'balance') {
    await balanceCommand.execute(interaction);
  }
});

const commands = [balanceCommand.data.toJSON()];
client.login(process.env.DISCORD_TOKEN)
  .then(() => {
    if (!client.application) {
      throw new Error('Client application is not ready');
    }
    return client.application.commands.set(commands);
  })
  .then(() => console.log('Slash commands registered successfully'))
  .catch(error => {
    console.error('Error during bot initialization:', error);
    process.exit(1);
  });