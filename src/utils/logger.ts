import winston from 'winston';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { Config } from '../types/config';

export class Logger {
  private logger: winston.Logger;
  private client: Client;
  private notificationChannelId: string;
  private errorChannelId: string;

  constructor(config: Config, discordClient: Client) {
    this.client = discordClient;
    this.notificationChannelId = config.discord.notification_channel_id;
    this.errorChannelId = config.discord.error_channel_id;

    this.logger = winston.createLogger({
      level: config.logger.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: config.logger.file_path,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          )
        }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
  }

  private async getChannel(channelId: string): Promise<TextChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        return channel as TextChannel;
      }
      return null;
    } catch (error) {
      this.error('Failed to fetch Discord channel', { channelId, error });
      return null;
    }
  }

  async logSwapSuccess(
    poolType: string,
    txHash: string,
    ethBefore: string,
    ethAfter: string,
    profit: string
  ) {
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle(`Successful Swap - ${poolType}`)
      .addFields(
        { name: 'Transaction', value: `[View on Etherscan](https://sepolia.etherscan.io/tx/${txHash})` },
        { name: 'ETH Balance Before', value: `${ethBefore} ETH` },
        { name: 'ETH Balance After', value: `${ethAfter} ETH` },
        { name: 'Profit', value: `${profit} ETH` }
      )
      .setTimestamp();

    const channel = await this.getChannel(this.notificationChannelId);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }

    this.info('Swap success', {
      poolType,
      txHash,
      ethBefore,
      ethAfter,
      profit
    });
  }

  async logError(error: Error, context: string) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Error Occurred')
      .addFields(
        { name: 'Context', value: context },
        { name: 'Error Message', value: error.message },
        { name: 'Stack Trace', value: error.stack || 'No stack trace available' }
      )
      .setTimestamp();

    const channel = await this.getChannel(this.errorChannelId);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }

    this.error('Error occurred', {
      context,
      error: error.message,
      stack: error.stack
    });
  }

  info(message: string, meta?: any) {
    this.logger.info(message, meta);
  }

  error(message: string, meta?: any) {
    this.logger.error(message, meta);
  }

  warn(message: string, meta?: any) {
    this.logger.warn(message, meta);
  }

  debug(message: string, meta?: any) {
    this.logger.debug(message, meta);
  }
}