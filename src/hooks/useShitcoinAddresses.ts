import { useMemo } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { nostrPubkeyToShitcoinAddresses, type ShitcoinWallet } from '@/lib/shitcoins';

/**
 * Derive the current user's shitcoin addresses (DOGE, LTC, BCH, BSV, ETH)
 * from their Nostr pubkey.
 *
 * These addresses are deterministic functions of the npub — no extra keys,
 * no network calls. They are derived assuming even-y parity (BIP-340 x-only
 * convention), matching the standalone `derive.ts` demo. See `lib/shitcoins.ts`
 * for the full rationale and spending caveats.
 */
export function useShitcoinAddresses(): { wallets: ShitcoinWallet[]; pubkey: string } {
  const { user } = useCurrentUser();

  const wallets = useMemo(() => {
    if (!user) return [];
    return nostrPubkeyToShitcoinAddresses(user.pubkey);
  }, [user]);

  return { wallets, pubkey: user?.pubkey ?? '' };
}
