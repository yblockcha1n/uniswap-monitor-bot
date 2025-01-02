import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { parse } from 'toml';

import { Config } from '../types/config';
import { SwapService } from './swapService';
import UniswapV3PoolABI from '../../abi/UniswapV3Pool.json';

const config = parse(readFileSync('./src/config/config.toml', 'utf-8')) as Config;
const POOL_ADDRESS = config.pool.address;

export class UniswapService {
  private provider: ethers.JsonRpcProvider;
  private poolContract: ethers.Contract;
  private wethContract: ethers.Contract;
  private swapService: SwapService;

  constructor(rpcUrl: string, privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.poolContract = new ethers.Contract(POOL_ADDRESS, UniswapV3PoolABI, this.provider);
    this.wethContract = new ethers.Contract(config.contracts.weth, ['function balanceOf(address) view returns (uint256)'], this.provider);
    this.swapService = new SwapService(rpcUrl, privateKey);
  }

  async getTokenAddresses(): Promise<{ token0Address: string; token1Address: string }> {
    const [token0Address, token1Address] = await Promise.all([
      this.poolContract.token0(),
      this.poolContract.token1()
    ]);
    return { token0Address, token1Address };
  }

  async getPoolBalance(): Promise<string> {
    try {
      const { token1Address } = await this.getTokenAddresses();
      const balanceWei = await this.wethContract.balanceOf(POOL_ADDRESS);
      const balance = ethers.formatEther(balanceWei);
      
      await this.checkAndExecuteSwap(balance);
      
      return balance;
    } catch (error) {
      console.error('Error in getPoolBalance:', error);
      throw error;
    }
  }

  private async checkAndExecuteSwap(balance: string): Promise<void> {
    const balanceNum = parseFloat(balance);
    
    if (balanceNum > config.swap.threshold) {
      console.log(`Balance ${balanceNum} ETH exceeds threshold ${config.swap.threshold} ETH. Executing swap...`);
      
      try {
        const withdrawalAmount = (balanceNum * config.swap.withdrawal_percentage) / 100;
        const withdrawalAmountWei = ethers.parseEther(withdrawalAmount.toString());

        await this.swapService.executeSwap(withdrawalAmountWei);

        const newBalanceWei = await this.wethContract.balanceOf(POOL_ADDRESS);
        const newBalance = ethers.formatEther(newBalanceWei);
        console.log(`Swap completed. New pool WETH balance: ${newBalance} ETH`);

        const targetBalance = balanceNum - withdrawalAmount;
        const actualBalance = parseFloat(newBalance);
        if (Math.abs(actualBalance - targetBalance) > 0.1) {
          console.warn('Warning: Actual balance differs significantly from target balance');
          console.log(`Target: ${targetBalance} ETH, Actual: ${actualBalance} ETH`);
        }
      } catch (error) {
        console.error('Error during swap execution:', error);
        throw error;
      }
    }
  }
}