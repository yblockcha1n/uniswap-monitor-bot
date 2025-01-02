export interface Config {
  pool: {
    address: string;
    update_interval: number;
    decimal_places: number;
  };
  discord: {
    status_update_interval: number;
  };
  swap: {
    threshold: number;
    withdrawal_percentage: number;
    gas_limit: number;
    priority_fee: string;
    max_fee: string;
  };
  contracts: {
    router: string;
    usdc: string;
    weth: string;
    mint_caller: string;
    batch_mint_amount: number;
  };
}