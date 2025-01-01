import { SlashCommandBuilder, CommandInteraction } from 'discord.js';
import { parse } from 'toml';
import { readFileSync } from 'fs';

import { UniswapService } from '../utils/uniswapService';
import { formatNumber } from '../utils/formatNumber';
import { EmbedBuilder } from 'discord.js';
import { Config } from '../types/config';

const config = parse(readFileSync('./src/config/config.toml', 'utf-8')) as Config;

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Get current WETH balance of the Uniswap V3 Pool');

export async function execute(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

  if (!process.env.PRIVATE_KEY) {
    console.error('PRIVATE_KEY is not defined in environment variables');
    await interaction.editReply('Error: Private key not configured');
    return;
  }

  try {
    const uniswapService = new UniswapService(process.env.RPC_URL!, process.env.PRIVATE_KEY);
    const balance = await uniswapService.getPoolBalance();
    
    const embed = new EmbedBuilder()
      .setTitle('Uniswap V3 Pool WETH Balance')
      .setColor(0x0099FF)
      .addFields(
        { name: 'Pool Address', value: config.pool.address },
        { name: 'WETH Balance', value: `${formatNumber(balance, config.pool.decimal_places)} WETH` }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching balance:', error);
    await interaction.editReply('Error fetching pool balance. Please try again later.');
  }
}