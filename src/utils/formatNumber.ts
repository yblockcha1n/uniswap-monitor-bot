export const formatNumber = (number: number | string, decimals = 4): string => {
    return Number(number).toFixed(decimals);
  };