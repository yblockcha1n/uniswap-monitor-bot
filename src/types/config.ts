export interface Config {
    pool: {
      address: string;
      update_interval: number;
      decimal_places: number;
    };
    discord: {
      status_update_interval: number;
    };
  }