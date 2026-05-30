import { useQuery } from '@tanstack/react-query';

import { useAppContext } from '@/hooks/useAppContext';
import { fetchEthAssets, fetchEthPrice, type EthAssetSnapshot } from '@/lib/eth';

/**
 * Fetch native ETH balance + every ERC-20 holding (including spam/airdrop
 * tokens) for the given derived ETH address. Returns `undefined` data while
 * loading and while the address is empty.
 */
export function useEthAssets(address: string): {
  data: EthAssetSnapshot | undefined;
  ethPrice: number | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const { config } = useAppContext();
  const endpoint = config.alchemyRpc;

  const { data, isLoading, error } = useQuery({
    queryKey: ['eth-assets', endpoint, address],
    queryFn: ({ signal }) => fetchEthAssets(address, endpoint, signal),
    enabled: !!address,
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  const { data: ethPrice } = useQuery({
    queryKey: ['eth-price'],
    queryFn: ({ signal }) => fetchEthPrice(signal),
    refetchInterval: 60_000,
    staleTime: 60_000,
    select: (v) => v ?? undefined,
  });

  return { data, ethPrice, isLoading, error };
}
