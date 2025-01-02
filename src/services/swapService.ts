import { ethers } from 'ethers';
import { Config, PoolType } from '../types/config';
import { Logger } from '../utils/logger';

export class SwapService {
 private provider: ethers.JsonRpcProvider;
 private signer: ethers.Wallet;
 private routerContract: ethers.Contract;
 private tokenContract: ethers.Contract;
 private mintCallerContract: ethers.Contract;
 private poolContract: ethers.Contract;
 private wethContract: ethers.Contract;
 private poolType: PoolType;
 private logger: Logger;
 private config: Config;
 private isProcessing: boolean = false;

 constructor(
   config: Config,
   logger: Logger,
   provider: ethers.JsonRpcProvider,
   poolType: PoolType
 ) {
   this.config = config;
   this.logger = logger;
   this.provider = provider;
   this.poolType = poolType;
   this.signer = new ethers.Wallet(process.env.PRIVATE_KEY!, this.provider);
   
   const poolConfig = config.pools[poolType];
   
   const ROUTER_ABI = require('../../abi/UniswapRouter.json');
   const ERC20_ABI = require('../../abi/ERC20.json');
   const MINT_CALLER_ABI = require('../../abi/MintCaller.json');
   const POOL_ABI = require('../../abi/UniswapV3Pool.json');
   const WETH_ABI = require('../../abi/WETH.json');

   this.routerContract = new ethers.Contract(config.contracts.router, ROUTER_ABI, this.signer);
   this.tokenContract = new ethers.Contract(poolConfig.token_address, ERC20_ABI, this.signer);
   this.mintCallerContract = new ethers.Contract(config.contracts.mint_caller, MINT_CALLER_ABI, this.signer);
   this.poolContract = new ethers.Contract(poolConfig.address, POOL_ABI, this.provider);
   this.wethContract = new ethers.Contract(config.contracts.weth, WETH_ABI, this.signer);
 }

 async getNonce(): Promise<number> {
   return await this.provider.getTransactionCount(this.signer.address);
 }

 private async executeTransaction(tx: ethers.ContractTransaction & { gasLimit?: number | bigint }, nonce: number) {
   const gasPrice = await this.provider.getFeeData();
   const maxFeePerGas = ethers.parseUnits(this.config.swap.max_fee, 'gwei');
   const maxPriorityFeePerGas = ethers.parseUnits(this.config.swap.priority_fee, 'gwei');

   const txRequest = {
     ...tx,
     nonce,
     maxFeePerGas: maxFeePerGas > gasPrice.maxFeePerGas! ? maxFeePerGas : gasPrice.maxFeePerGas,
     maxPriorityFeePerGas: maxPriorityFeePerGas > gasPrice.maxPriorityFeePerGas! ? 
       maxPriorityFeePerGas : gasPrice.maxPriorityFeePerGas
   };

   return await this.signer.sendTransaction(txRequest);
 }

 async getPoolBalance(): Promise<string> {
   try {
     const balanceWei = await this.wethContract.balanceOf(this.config.pools[this.poolType].address);
     return ethers.formatEther(balanceWei);
   } catch (error) {
     this.logger.error('Error getting pool balance', { 
       poolType: this.poolType, 
       error: error 
     });
     throw error;
   }
 }

 private async unwrapWETH(amount: bigint): Promise<string> {
   try {
     const ethBalanceBefore = await this.provider.getBalance(this.signer.address);
     
     const nonce = await this.getNonce();
     const tx = await this.wethContract.withdraw.populateTransaction(amount);
     const result = await this.executeTransaction({
       ...tx,
       gasLimit: BigInt(100000)
     }, nonce);

     const receipt = await result.wait();
     
     const ethBalanceAfter = await this.provider.getBalance(this.signer.address);
     const profit = ethBalanceAfter - ethBalanceBefore;
     
     await this.logger.logSwapSuccess(
       this.poolType,
       result.hash,
       ethers.formatEther(ethBalanceBefore),
       ethers.formatEther(ethBalanceAfter),
       ethers.formatEther(profit)
     );

     return result.hash;
   } catch (error) {
     this.logger.error('Error unwrapping WETH', {
       poolType: this.poolType,
       amount: amount.toString(),
       error: error
     });
     throw error;
   }
 }

 private async calculateRequiredTokenAmount(wethAmount: bigint): Promise<bigint> {
  try {
    const [tokenBalance, wethBalance] = await Promise.all([
      this.tokenContract.balanceOf(this.config.pools[this.poolType].address),
      this.wethContract.balanceOf(this.config.pools[this.poolType].address)
    ]);
    
    const poolConfig = this.config.pools[this.poolType];
    
    const wethDecimals = BigInt(10 ** 18);
    const tokenDecimals = BigInt(10 ** poolConfig.token_decimals);
    
    const requiredAmount = (tokenBalance * wethAmount) / wethBalance;
    
    this.logger.info('Token amount calculation', {
      poolType: this.poolType,
      wethAmountRaw: wethAmount.toString(),
      wethAmountFormatted: ethers.formatEther(wethAmount),
      tokenBalanceRaw: tokenBalance.toString(),
      tokenBalanceFormatted: ethers.formatUnits(tokenBalance, poolConfig.token_decimals),
      wethBalanceRaw: wethBalance.toString(),
      wethBalanceFormatted: ethers.formatEther(wethBalance),
      requiredAmountRaw: requiredAmount.toString(),
      requiredAmountFormatted: ethers.formatUnits(requiredAmount, poolConfig.token_decimals),
      tokenDecimals: poolConfig.token_decimals
    });
    
    return requiredAmount;
  } catch (error) {
    this.logger.error('Error calculating required token amount', {
      poolType: this.poolType,
      wethAmount: wethAmount.toString(),
      error: error
    });
    throw error;
  }
}

 private async mintTokens(targetAmount: bigint): Promise<void> {
   try {
     const poolConfig = this.config.pools[this.poolType];
     const batchSize = poolConfig.batch_mint_amount;
     const mintMethod = `batchMint${this.poolType.split('_')[0].toUpperCase()}`;

     let currentBalance = await this.tokenContract.balanceOf(this.signer.address);
     
     while (currentBalance < targetAmount) {
       const nonce = await this.getNonce();
       const tx = await this.mintCallerContract[mintMethod].populateTransaction(batchSize);
       const result = await this.executeTransaction({
         ...tx,
         gasLimit: BigInt(10000000)
       }, nonce);
       
       await result.wait();
       currentBalance = await this.tokenContract.balanceOf(this.signer.address);
       
       this.logger.info('Minted tokens', {
         poolType: this.poolType,
         batchSize: batchSize,
         currentBalance: currentBalance.toString(),
         targetAmount: targetAmount.toString(),
         txHash: result.hash
       });

       await new Promise(resolve => setTimeout(resolve, 1000));
     }
   } catch (error) {
     this.logger.error('Error minting tokens', {
       poolType: this.poolType,
       targetAmount: targetAmount.toString(),
       error: error
     });
     throw error;
   }
 }

 private async checkAndApproveToken(spender: string, amount: bigint): Promise<void> {
   try {
     const allowance = await this.tokenContract.allowance(this.signer.address, spender);
     if (allowance < amount) {
       const nonce = await this.getNonce();
       const tx = await this.tokenContract.approve.populateTransaction(spender, amount);
       const result = await this.executeTransaction({
         ...tx,
         gasLimit: BigInt(100000)
       }, nonce);
       
       await result.wait();
       this.logger.info('Token approved', {
         poolType: this.poolType,
         spender: spender,
         amount: amount.toString()
       });
     }
   } catch (error) {
     this.logger.error('Error approving token', {
       poolType: this.poolType,
       spender: spender,
       amount: amount.toString(),
       error: error
     });
     throw error;
   }
 }

 async executeSwap(): Promise<void> {
   if (this.isProcessing) {
     this.logger.info('Swap already in progress, skipping', {
       poolType: this.poolType
     });
     return;
   }

   this.isProcessing = true;

   try {
     const poolConfig = this.config.pools[this.poolType];
     const balance = await this.getPoolBalance();
     const balanceNum = parseFloat(balance);
     
     if (balanceNum <= poolConfig.threshold) {
       return;
     }

     const withdrawalAmount = (balanceNum * poolConfig.withdrawal_percentage) / 100;
     const withdrawalAmountWei = ethers.parseEther(withdrawalAmount.toString());
     
     const requiredTokens = await this.calculateRequiredTokenAmount(withdrawalAmountWei);
     const requiredTokensWithBuffer = (requiredTokens * BigInt(110)) / BigInt(100);
     
     await this.mintTokens(requiredTokensWithBuffer);
     await this.checkAndApproveToken(this.config.contracts.router, requiredTokensWithBuffer);
     
     const params = {
       tokenIn: this.config.pools[this.poolType].token_address,
       tokenOut: this.config.contracts.weth,
       fee: await this.poolContract.fee(),
       recipient: this.signer.address,
       deadline: Math.floor(Date.now() / 1000) + 60 * 20,
       amountIn: requiredTokensWithBuffer,
       amountOutMinimum: 0n,
       sqrtPriceLimitX96: 0
     };

     this.logger.info('Executing swap with params', {
       poolType: this.poolType,
       params: {
         ...params,
         amountIn: params.amountIn.toString(),
         amountOutMinimum: params.amountOutMinimum.toString()
       }
     });

     const nonce = await this.getNonce();
     const tx = await this.routerContract.exactInputSingle.populateTransaction(params);
     const result = await this.executeTransaction({
       ...tx,
       gasLimit: BigInt(this.config.swap.gas_limit)
     }, nonce);

     await result.wait();
     
     const acquiredWETH = await this.wethContract.balanceOf(this.signer.address);
     if (acquiredWETH > BigInt(0)) {
       await this.unwrapWETH(acquiredWETH);
     }
   } catch (error) {
     this.logger.error('Error executing swap', {
       poolType: this.poolType,
       error: error
     });
     throw error;
   } finally {
     this.isProcessing = false;
   }
 }
}