import { 
  SlashCommandBuilder, 
  CommandInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder 
} from 'discord.js';
import { ethers } from 'ethers';

import { Config, PoolType } from '../types/config';
import { SwapService } from '../services/swapService';
import { Logger } from '../utils/logger';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Get current WETH balance of a specific Uniswap V3 Pool')
  .addStringOption(option =>
    option.setName('pool')
      .setDescription('The pool to check')
      .setRequired(true)
      .addChoices(
        { name: 'USDC/WETH', value: 'usdc_weth' },
        { name: 'USDT/WETH', value: 'usdt_weth' },
        { name: 'DAI/WETH', value: 'dai_weth' }
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  config: Config,
  logger: Logger,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  await interaction.deferReply();

  try {
    const poolType = interaction.options.getString('pool', true) as PoolType;
    const poolConfig = config.pools[poolType];
    
    const swapService = new SwapService(
      config,
      logger,
      provider,
      poolType
    );
    
    const balance = await swapService.getPoolBalance();
    
    const embed = new EmbedBuilder()
      .setTitle(`${poolType.toUpperCase().replace('_', '/')} Pool Balance`)
      .setColor(0x0099FF)
      .addFields(
        { name: 'Pool Address', value: `[${poolConfig.address}](https://sepolia.etherscan.io/address/${poolConfig.address})` },
        { name: 'Token Address', value: `[${poolConfig.token_address}](https://sepolia.etherscan.io/address/${poolConfig.token_address})` },
        { name: 'WETH Balance', value: `${Number(balance).toFixed(poolConfig.decimal_places)} WETH` }
      )
      .setFooter({ text: 'Last Updated' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await logger.logError(error as Error, 'Balance command execution');
    await interaction.editReply('Error fetching pool balance. Please try again later.');
  }
}