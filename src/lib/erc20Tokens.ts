/**
 * Lightweight ERC-20 token registry, separated from the signer module so
 * non-crypto callers (zapHelpers, formatters, post-zap renderers) can
 * read token metadata without pulling in the @noble/curves bundle.
 */

export interface Erc20Token {
  symbol: string;
  name: string;
  /** Contract address (mainnet). */
  contract: string;
  decimals: number;
  emoji: string;
  /** Coingecko id for the USD price feed. */
  coingeckoId: string;
  /** Memey one-liner. */
  tagline: string;
}

/**
 * Curated list of ERC-20 tokens Magikarp can zap. Picked for max meme
 * density (stablecoins + popular dog/frog meme tokens). All contracts
 * are mainnet. To add a new token, append here; the signer, balance
 * fetcher, and UI picker handle it generically.
 */
export const ERC20_TOKENS: Erc20Token[] = [
  {
    symbol: 'USDT',
    name: 'Tether',
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    emoji: '💵',
    coingeckoId: 'tether',
    tagline: 'pegged 1:1 to USD. (trust me bro.)',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    emoji: '💸',
    coingeckoId: 'usd-coin',
    tagline: 'reg-compliant stablecoin. (so trust circle, instead.)',
  },
  {
    symbol: 'DAI',
    name: 'Dai',
    contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    emoji: '🟡',
    coingeckoId: 'dai',
    tagline: 'decentralized stable... ish.',
  },
  {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    contract: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    decimals: 18,
    emoji: '🐕',
    coingeckoId: 'shiba-inu',
    tagline: 'doge but on ETH because gas fees aren’t suffering enough.',
  },
  {
    symbol: 'PEPE',
    name: 'Pepe',
    contract: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    decimals: 18,
    emoji: '🐸',
    coingeckoId: 'pepe',
    tagline: 'feels good man.',
  },
];

/** Look up an ERC-20 by symbol (case-insensitive). */
export function findErc20Token(symbol: string): Erc20Token | undefined {
  const upper = symbol.toUpperCase();
  return ERC20_TOKENS.find((t) => t.symbol === upper);
}
