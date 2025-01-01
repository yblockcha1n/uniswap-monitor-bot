import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { parse } from 'toml';

import { Config } from '../types/config';
import UniswapV3PoolABI from '../../abi/UniswapV3Pool.json';

const config = parse(readFileSync('./src/config/config.toml', 'utf-8')) as Config;
const POOL_ADDRESS = config.pool.address;

export class UniswapService {
  private provider: ethers.JsonRpcProvider;
  private poolContract: ethers.Contract;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.poolContract = new ethers.Contract(POOL_ADDRESS, UniswapV3PoolABI, this.provider);
  }

  async getTokenAddresses(): Promise<{ token0Address: string; token1Address: string }> {
    const [token0Address, token1Address] = await Promise.all([
      this.poolContract.token0(),
      this.poolContract.token1()
    ]);
    return { token0Address, token1Address };
  }

  async getPoolBalance(): Promise<string> {
    const { token1Address } = await this.getTokenAddresses();
    
    const wethInterface = new ethers.Interface([
      "function balanceOf(address) view returns (uint256)"
    ]);
    
    const wethContract = new ethers.Contract(token1Address, wethInterface, this.provider);
    const balanceWei = await wethContract.balanceOf(POOL_ADDRESS);
    const balance = ethers.formatEther(balanceWei);
    
    return balance;
  }
}