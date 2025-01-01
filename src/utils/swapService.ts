import { ethers } from 'ethers';
import { parse } from 'toml';
import { readFileSync } from 'fs';
import { Config } from '../types/config';

const config = parse(readFileSync('./src/config/config.toml', 'utf-8')) as Config;

export class SwapService {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private routerContract: ethers.Contract;
  private usdcContract: ethers.Contract;
  private mintCallerContract: ethers.Contract;
  private quoterContract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    
    const ROUTER_ABI = JSON.parse(readFileSync('./abi/UniswapRouter.json', 'utf-8'));
    const USDC_ABI = JSON.parse(readFileSync('./abi/USDC.json', 'utf-8'));
    const MINT_CALLER_ABI = JSON.parse(readFileSync('./abi/MintCaller.json', 'utf-8'));
    const QUOTER_ABI = JSON.parse(readFileSync('./abi/UniswapQuoterV2.json', 'utf-8'));

    this.routerContract = new ethers.Contract(config.contracts.router, ROUTER_ABI, this.signer);
    this.usdcContract = new ethers.Contract(config.contracts.usdc, USDC_ABI, this.signer);
    this.mintCallerContract = new ethers.Contract(config.contracts.mint_caller, MINT_CALLER_ABI, this.signer);
    this.quoterContract = new ethers.Contract(config.contracts.quoter, QUOTER_ABI, this.provider);
  }

  private async estimateGasWithBuffer(
    contract: ethers.Contract,
    method: string,
    args: any[],
    bufferPercent: number = 50
  ): Promise<bigint> {
    try {
      const estimatedGas = await contract[method].estimateGas(...args);
      const gasWithBuffer = (estimatedGas * BigInt(100 + bufferPercent)) / BigInt(100);
      console.log(`Estimated gas for ${method}: ${estimatedGas.toString()} (with ${bufferPercent}% buffer: ${gasWithBuffer.toString()})`);
      return gasWithBuffer;
    } catch (error) {
      console.error(`Gas estimation failed for ${method}:`, error);
      throw error;
    }
  }

  private async checkAndApproveToken(spender: string, amount: bigint): Promise<void> {
    try {
      const allowance = await this.usdcContract.allowance(this.signer.address, spender);
      if (allowance < amount) {
        console.log('Approving USDC...');
        const gasLimit = await this.estimateGasWithBuffer(
          this.usdcContract,
          'approve',
          [spender, amount]
        );
        
        const tx = await this.usdcContract.approve(spender, amount, {
          gasLimit,
          maxFeePerGas: ethers.parseUnits(config.swap.max_fee, 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits(config.swap.priority_fee, 'gwei')
        });
        
        console.log('Approval transaction sent:', tx.hash);
        await tx.wait();
        console.log('USDC approved successfully');
      } else {
        console.log('USDC already approved');
      }
    } catch (error) {
      console.error('Error in token approval:', error);
      throw error;
    }
  }

  private async getUSDCBalance(): Promise<bigint> {
    return await this.usdcContract.balanceOf(this.signer.address);
  }

  private async executeOneMint(): Promise<void> {
    console.log('Executing one batch mint...');
    const gasLimit = await this.estimateGasWithBuffer(
      this.mintCallerContract,
      'batchMintUSDC',
      [config.contracts.batch_mint_amount],
      100
    );

    const tx = await this.mintCallerContract.batchMintUSDC(
      config.contracts.batch_mint_amount,
      {
        gasLimit,
        maxFeePerGas: ethers.parseUnits(config.swap.max_fee, 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits(config.swap.priority_fee, 'gwei')
      }
    );
    
    console.log('Batch mint transaction sent:', tx.hash);
    const receipt = await tx.wait();
    
    if (receipt.status === 0) {
      throw new Error('Batch mint transaction failed');
    }
    console.log('One batch mint completed successfully');
  }

  async executeBatchMintUntilTarget(targetAmount: bigint): Promise<void> {
    try {
      let currentBalance = await this.getUSDCBalance();
      console.log('Current USDC balance:', currentBalance.toString());
      console.log('Target USDC amount:', targetAmount.toString());

      while (currentBalance < targetAmount) {
        await this.executeOneMint();
        currentBalance = await this.getUSDCBalance();
        console.log('Updated USDC balance:', currentBalance.toString());
      }
      
      console.log('Reached target USDC amount');
    } catch (error) {
      console.error('Error in batch minting:', error);
      throw error;
    }
  }

  private async getRequiredUSDCAmount(wethAmount: bigint): Promise<bigint> {
    try {
      const [amountIn, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = 
        await this.quoterContract.quoteExactOutput.staticCall([
          config.contracts.usdc,
          config.pool.address,
          3000,
          wethAmount,
          0
        ]);

      console.log('Quote details:');
      console.log('- Required USDC:', ethers.formatUnits(amountIn, 6));
      console.log('- Price after swap:', sqrtPriceX96After.toString());
      console.log('- Ticks crossed:', initializedTicksCrossed.toString());
      console.log('- Estimated gas:', gasEstimate.toString());

      return amountIn;
    } catch (error) {
      console.error('Error getting quote:', error);
      throw error;
    }
  }

  async executeSwap(wethTargetAmount: bigint): Promise<void> {
    try {
      console.log('Calculating required USDC amount for', ethers.formatEther(wethTargetAmount), 'WETH');
      const requiredUSDC = await this.getRequiredUSDCAmount(wethTargetAmount);
      const requiredUSDCWithBuffer = (requiredUSDC * BigInt(110)) / BigInt(100); // 10% buffer
      console.log('Required USDC amount (with 10% buffer):', ethers.formatUnits(requiredUSDCWithBuffer, 6));

      const currentUSDCBalance = await this.getUSDCBalance();
      if (currentUSDCBalance < requiredUSDCWithBuffer) {
        console.log('Insufficient USDC balance, minting more...');
        await this.executeBatchMintUntilTarget(requiredUSDCWithBuffer);
      }

      console.log('Approving USDC for swap...');
      await this.checkAndApproveToken(config.contracts.router, requiredUSDCWithBuffer);

      const params = {
        tokenIn: config.contracts.usdc,
        tokenOut: config.pool.address,
        fee: 3000,
        recipient: this.signer.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        amountIn: requiredUSDCWithBuffer,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      };

      console.log('Executing swap with params:', {
        ...params,
        amountIn: ethers.formatUnits(params.amountIn, 6),
        deadline: new Date(params.deadline * 1000).toISOString()
      });

      const tx = await this.routerContract.exactInputSingle(
        params,
        {
          gasLimit: config.swap.gas_limit,
          maxFeePerGas: ethers.parseUnits(config.swap.max_fee, 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits(config.swap.priority_fee, 'gwei')
        }
      );

      console.log('Swap transaction sent:', tx.hash);
      const receipt = await tx.wait();
      
      if (receipt.status === 0) {
        throw new Error('Swap transaction failed');
      }
      
      console.log('Swap completed successfully');
    } catch (error) {
      console.error('Error in swap execution:', error);
      throw error;
    }
  }
}