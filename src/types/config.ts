export interface PoolConfig {
  address: string;
  token_address: string;
  token_decimals: number;
  update_interval: number;
  decimal_places: number;
  threshold: number;
  withdrawal_percentage: number;
  batch_mint_amount: number;
}

export interface LoggerConfig {
  level: string;
  file_path: string;
}

export interface Config {
  discord: {
    status_update_interval: number;
    notification_channel_id: string;
    error_channel_id: string;
  };
  swap: {
    gas_limit: number;
    priority_fee: string;
    max_fee: string;
  };
  contracts: {
    router: string;
    weth: string;
    mint_caller: string;
  };
  pools: {
    usdc_weth: PoolConfig;
    usdt_weth: PoolConfig;
    dai_weth: PoolConfig;
  };
  logger: LoggerConfig;
}

export type PoolType = 'usdc_weth' | 'usdt_weth' | 'dai_weth';