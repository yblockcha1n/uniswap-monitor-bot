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
  private swapService: SwapService;

  constructor(rpcUrl: string, privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.poolContract = new ethers.Contract(POOL_ADDRESS, UniswapV3PoolABI, this.provider);
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
      
      const wethInterface = new ethers.Interface([
        "function balanceOf(address) view returns (uint256)"
      ]);
      
      const wethContract = new ethers.Contract(token1Address, wethInterface, this.provider);
      const balanceWei = await wethContract.balanceOf(POOL_ADDRESS);
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
        // Calculate withdrawal amount (90% of current balance)
        const withdrawalAmount = (balanceNum * config.swap.withdrawal_percentage) / 100;
        const withdrawalAmountWei = ethers.parseEther(withdrawalAmount.toString());

        // Execute swap with exact output amount
        await this.swapService.executeSwap(withdrawalAmountWei);

        // Verify the swap was successful by checking new balance
        const newBalance = await this.poolContract.balanceOf(POOL_ADDRESS);
        const newBalanceEth = ethers.formatEther(newBalance);
        console.log(`Swap completed. New pool balance: ${newBalanceEth} ETH`);

        // Verify if we achieved our target
        const targetBalance = balanceNum - withdrawalAmount;
        const actualBalance = parseFloat(newBalanceEth);
        console.log(`Target balance: ${targetBalance} ETH, Actual balance: ${actualBalance} ETH`);

        if (Math.abs(actualBalance - targetBalance) > 0.1) { // 0.1 ETH tolerance
          console.warn('Warning: Actual balance differs significantly from target balance');
        }
      } catch (error) {
        console.error('Error during swap execution:', error);
        throw error;
      }
    }
  }
}