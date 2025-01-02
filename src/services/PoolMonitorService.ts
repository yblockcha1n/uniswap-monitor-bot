import { ethers } from 'ethers';
import { Config, PoolType } from '../types/config';
import { Logger } from '../utils/logger';
import { SwapService } from './swapService';

export class PoolMonitorService {
 private provider: ethers.JsonRpcProvider;
 private config: Config;
 private logger: Logger;
 private swapServices: Map<PoolType, SwapService>;
 private isProcessing: boolean = false;
 private interval: NodeJS.Timeout | null = null;
 private readonly processOrder: PoolType[] = ['usdc_weth', 'usdt_weth', 'dai_weth'];
 private currentPoolIndex: number = 0;

 constructor(
   config: Config,
   logger: Logger,
   provider: ethers.JsonRpcProvider
 ) {
   this.config = config;
   this.logger = logger;
   this.provider = provider;
   this.swapServices = new Map();
   this.initializeSwapServices();
 }

 private initializeSwapServices() {
   for (const poolType of this.processOrder) {
     this.swapServices.set(
       poolType,
       new SwapService(
         this.config,
         this.logger,
         this.provider,
         poolType
       )
     );
   }
 }

 private async processNextPool() {
   if (this.isProcessing) {
     return;
   }

   this.isProcessing = true;
   try {
     const currentPool = this.processOrder[this.currentPoolIndex];
     const swapService = this.swapServices.get(currentPool);
     
     if (!swapService) {
       throw new Error(`SwapService not found for pool type: ${currentPool}`);
     }

     const balance = await swapService.getPoolBalance();
     const poolConfig = this.config.pools[currentPool];

     this.logger.info(`Processing ${currentPool}`, {
       balance,
       threshold: poolConfig.threshold
     });

     if (parseFloat(balance) > poolConfig.threshold) {
       this.logger.info(`Executing swap for ${currentPool}`, {
         balance,
         threshold: poolConfig.threshold
       });
       await swapService.executeSwap();
     }

     this.currentPoolIndex = (this.currentPoolIndex + 1) % this.processOrder.length;
   } catch (error) {
     this.logger.error('Error processing pool', {
       poolType: this.processOrder[this.currentPoolIndex],
       error: error instanceof Error ? error.message : 'Unknown error'
     });
   } finally {
     this.isProcessing = false;
   }
 }

 async startMonitoring() {
   if (this.interval) {
     return;
   }

   this.logger.info('Starting sequential pool monitoring');
   this.interval = setInterval(() => this.processNextPool(), 30000);
   await this.processNextPool();
 }

 async stopMonitoring() {
   if (this.interval) {
     clearInterval(this.interval);
     this.interval = null;
   }
   this.isProcessing = false;
   this.logger.info('Pool monitoring stopped');
 }
}