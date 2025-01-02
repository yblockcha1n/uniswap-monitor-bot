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
  private poolContract: ethers.Contract;
  private wethContract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    
    const ROUTER_ABI = JSON.parse(readFileSync('./abi/UniswapRouter.json', 'utf-8'));
    const USDC_ABI = JSON.parse(readFileSync('./abi/USDC.json', 'utf-8'));
    const MINT_CALLER_ABI = JSON.parse(readFileSync('./abi/MintCaller.json', 'utf-8'));
    const POOL_ABI = JSON.parse(readFileSync('./abi/UniswapV3Pool.json', 'utf-8'));
    const WETH_ABI = JSON.parse(readFileSync('./abi/WETH.json', 'utf-8'));

    this.routerContract = new ethers.Contract(config.contracts.router, ROUTER_ABI, this.signer);
    this.usdcContract = new ethers.Contract(config.contracts.usdc, USDC_ABI, this.signer);
    this.mintCallerContract = new ethers.Contract(config.contracts.mint_caller, MINT_CALLER_ABI, this.signer);
    this.poolContract = new ethers.Contract(config.pool.address, POOL_ABI, this.provider);
    this.wethContract = new ethers.Contract(config.contracts.weth, WETH_ABI, this.signer);
  }

  private async getPoolBalances(): Promise<{ wethBalance: bigint, usdcBalance: bigint }> {
    const [wethBalance, usdcBalance] = await Promise.all([
      this.wethContract.balanceOf(config.pool.address),
      this.usdcContract.balanceOf(config.pool.address)
    ]);
    return { wethBalance, usdcBalance };
  }

  private async unwrapWETH(amount: bigint): Promise<void> {
    try {
      console.log('Unwrapping WETH to ETH...');
      console.log('Amount to unwrap:', ethers.formatEther(amount), 'WETH');

      const tx = await this.wethContract.withdraw(amount, {
        gasLimit: 100000,
        maxFeePerGas: ethers.parseUnits(config.swap.max_fee, 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits(config.swap.priority_fee, 'gwei')
      });

      console.log('Unwrap transaction sent:', tx.hash);
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        throw new Error('Unwrap transaction failed');
      }

      const ethBalance = await this.provider.getBalance(this.signer.address);
      console.log('Unwrap completed successfully');
      console.log('Current ETH balance:', ethers.formatEther(ethBalance), 'ETH');
    } catch (error) {
      console.error('Error in unwrapping WETH:', error);
      throw error;
    }
  }

  private async calculateRequiredUSDC(wethAmount: bigint): Promise<bigint> {
    const { wethBalance, usdcBalance } = await this.getPoolBalances();
    
    // プール内の比率から必要なUSDC量を計算(自力実装)
    // (USDC残高 * 取引wETH量) / wETH残高
    const requiredUSDC = (usdcBalance * wethAmount) / wethBalance;
    
    console.log('Pool balance calculation:');
    console.log('- Pool WETH balance:', ethers.formatEther(wethBalance), 'WETH');
    console.log('- Pool USDC balance:', ethers.formatUnits(usdcBalance, 6), 'USDC');
    console.log('- Target WETH amount:', ethers.formatEther(wethAmount), 'WETH');
    console.log('- Required USDC amount:', ethers.formatUnits(requiredUSDC, 6), 'USDC');
    
    return requiredUSDC;
  }

  private async checkAndApproveToken(spender: string, amount: bigint): Promise<void> {
    try {
      const allowance = await this.usdcContract.allowance(this.signer.address, spender);
      if (allowance < amount) {
        console.log('Approving USDC...');
        const tx = await this.usdcContract.approve(spender, amount, {
          gasLimit: 100000,
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

  private async getWETHBalance(): Promise<bigint> {
    return await this.wethContract.balanceOf(this.signer.address);
  }

  private async executeOneMint(): Promise<void> {
    console.log('Executing one batch mint...');
    const tx = await this.mintCallerContract.batchMintUSDC(
      config.contracts.batch_mint_amount,
      {
        gasLimit: 10000000,
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
      console.log('Current USDC balance:', ethers.formatUnits(currentBalance, 6), 'USDC');
      console.log('Target USDC amount:', ethers.formatUnits(targetAmount, 6), 'USDC');

      while (currentBalance < targetAmount) {
        await this.executeOneMint();
        currentBalance = await this.getUSDCBalance();
        console.log('Updated USDC balance:', ethers.formatUnits(currentBalance, 6), 'USDC');
      }
      
      console.log('Reached target USDC amount');
    } catch (error) {
      console.error('Error in batch minting:', error);
      throw error;
    }
  }

  async executeSwap(wethTargetAmount: bigint): Promise<void> {
    try {
      const requiredUSDC = await this.calculateRequiredUSDC(wethTargetAmount);
      const usdcAmountWithBuffer = (requiredUSDC * BigInt(110)) / BigInt(100); // 10% buffer

      console.log('Required USDC with 10% buffer:', ethers.formatUnits(usdcAmountWithBuffer, 6), 'USDC');

      const currentUSDCBalance = await this.getUSDCBalance();
      if (currentUSDCBalance < usdcAmountWithBuffer) {
        console.log('Insufficient USDC balance, minting more...');
        await this.executeBatchMintUntilTarget(usdcAmountWithBuffer);
      }

      console.log('Approving USDC for swap...');
      await this.checkAndApproveToken(config.contracts.router, usdcAmountWithBuffer);

      const [token0, token1] = await Promise.all([
        this.poolContract.token0(),
        this.poolContract.token1()
      ]);
      const poolFee = await this.poolContract.fee();

      const params = {
        tokenIn: config.contracts.usdc,
        tokenOut: config.contracts.weth,
        fee: poolFee,
        recipient: this.signer.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        amountIn: usdcAmountWithBuffer,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      };

      console.log('Pool and swap details:');
      console.log('- Target pool:', config.pool.address);
      console.log('- Token0:', token0);
      console.log('- Token1:', token1);
      console.log('- Pool fee:', poolFee);
      console.log('Swap parameters:');
      console.log('- USDC (in):', ethers.formatUnits(params.amountIn, 6));
      console.log('- Expected WETH (out):', ethers.formatEther(wethTargetAmount));
      console.log('- Deadline:', new Date(params.deadline * 1000).toISOString());

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

      const finalPoolBalances = await this.getPoolBalances();
      console.log('Final pool balances:');
      console.log('- WETH:', ethers.formatEther(finalPoolBalances.wethBalance), 'WETH');
      console.log('- USDC:', ethers.formatUnits(finalPoolBalances.usdcBalance, 6), 'USDC');

      const acquiredWETH = await this.getWETHBalance();
      console.log('Acquired WETH balance:', ethers.formatEther(acquiredWETH), 'WETH');

      if (acquiredWETH > BigInt(0)) {
        await this.unwrapWETH(acquiredWETH);
      }

      const finalEthBalance = await this.provider.getBalance(this.signer.address);
      console.log('Final ETH balance:', ethers.formatEther(finalEthBalance), 'ETH');
    } catch (error) {
      console.error('Error in swap execution:', error);
      throw error;
    }
  }
}