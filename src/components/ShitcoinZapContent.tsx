import { useMemo, useState } from 'react';
import { Copy, Check, ExternalLink, Rocket, Loader2 } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools';
import { useNostrLogin } from '@nostrify/react/login';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import {
  nostrPubkeyToShitcoinAddresses,
  shitcoinUri,
  type ShitcoinId,
} from '@/lib/shitcoins';
import { useQuery } from '@tanstack/react-query';
import { useShitcoinBalances } from '@/hooks/useShitcoinBalances';
import { formatShitcoinAmount, formatShitcoinUsd } from '@/lib/shitcoinBalances';
import { fetchErc20Balance } from '@/lib/shitcoinSigners';
import {
  canSignShitcoin,
  signAndBroadcastShitcoin,
  signAndBroadcastErc20,
  findErc20Token,
  ERC20_TOKENS,
  type SignAndBroadcastResult,
  type Erc20Token,
} from '@/lib/shitcoinSigners';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { openUrl } from '@/lib/downloadFile';

/**
 * The font stack that gives shitcoin UI its Doge-meme aesthetic. Comic Neue
 * is preferred (loaded via the theme system) with system Comic Sans variants
 * and cursive as fallbacks so the joke lands even before the webfont loads.
 */
const DOGE_FONT = '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive, sans-serif';

/**
 * Parse a whole-coin amount string (e.g. `"1.5"`) into atomic units (e.g.
 * `150000000n` for 8-decimal sats). String-based so we don't lose precision
 * at 18 decimals — `Math.round("1.000000000000000001" * 1e18)` would round.
 * Throws on invalid input.
 */
function parseAtomicUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${amountStr}"`);
  }
  const [whole, fracRaw = ''] = trimmed.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`Too many decimal places for chain (max ${decimals})`);
  }
  const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded);
}

interface ShitcoinZapContentProps {
  /**
   * The event being zapped. Used for:
   *   - `target.pubkey` → recipient identity (the npub whose shitcoin
   *     addresses we derive),
   *   - `target.id` → the post the zap is attached to (added as an `e` tag
   *     on the kind 8333 receipt so it surfaces under the post),
   *   - `target.kind` → if addressable, we also add an `a` tag.
   */
  target: NostrEvent;
}

/**
 * "Send Shitcoin" zap tab. Every npub deterministically maps to a wallet on
 * DOGE / LTC / BCH / BSV / ETH / ZEC / ATOM, so the recipient's chain
 * addresses are derivable here with no network calls.
 *
 * For **DOGE / LTC / BSV** (the BTC-like P2PKH chains with working public
 * UTXO + push endpoints), the Send button signs and broadcasts a real
 * transaction directly from the user's nsec — no external wallet needed.
 * For BCH / ZEC / ETH / ATOM, native signing isn't shipped in this fork
 * (each needs its own pipeline — BLAKE2b Sapling sighash for ZEC, RLP +
 * EIP-1559 for ETH, protobuf SignDoc + cosmjs for ATOM), so those chains
 * keep a copy-address + deeplink fallback.
 *
 * Native signing is **nsec-only** — NIP-07 extensions and NIP-46 bunkers
 * don't define a way to sign non-BTC transactions, so users with remote
 * signers see a clear "your signer can't sign $CHAIN" gate.
 *
 * No kind 8333 receipt is published on shitcoin sends either; those chains
 * don't know what Nostr is. The joke is structural: the wallet *looks* like
 * a real integration because every npub really does have these addresses
 * and Magikarp really does broadcast on the supported chains — it's just
 * that "having an address" and "having a usable cross-chain identity" are
 * different things, which is the whole satirical argument.
 */
export function ShitcoinZapContent({ target }: ShitcoinZapContentProps) {
  const recipientPubkey = target.pubkey;
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const senderLogin = logins[0];
  const isNsecLogin = senderLogin?.type === 'nsec';

  // Recipient wallets (derived from the target pubkey we were given).
  const recipientWallets = useMemo(
    () => nostrPubkeyToShitcoinAddresses(recipientPubkey),
    [recipientPubkey],
  );

  // Sender wallets (current user's own derived shitcoin addresses — the
  // source of funds when we sign+broadcast natively).
  const senderWallets = useMemo(() => {
    if (!user) return [];
    return nostrPubkeyToShitcoinAddresses(user.pubkey);
  }, [user]);

  const { joined: recipientBalances } = useShitcoinBalances(recipientWallets);
  const { joined: senderBalances } = useShitcoinBalances(senderWallets);
  const recipientById = useMemo(
    () => new Map(recipientBalances.map((b) => [b.wallet.id, b])),
    [recipientBalances],
  );
  const senderById = useMemo(
    () => new Map(senderBalances.map((b) => [b.wallet.id, b])),
    [senderBalances],
  );

  // DOGE first, always — the wallets array is ordered with DOGE at index 0,
  // and the chain picker visually leads with DOGE: the satirical payoff.
  const [selectedId, setSelectedId] = useState<ShitcoinId>('DOGE');
  // When ETH is the selected chain, the user can also pick an ERC-20 token
  // (USDT, USDC, DAI, SHIB, PEPE) instead of native ETH. `'ETH'` = native;
  // any other value is an ERC-20 symbol resolved via findErc20Token.
  const [selectedTokenSymbol, setSelectedTokenSymbol] = useState<string>('ETH');
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SignAndBroadcastResult | null>(null);

  const recipient = recipientWallets.find((w) => w.id === selectedId) ?? recipientWallets[0];
  const sender = senderWallets.find((w) => w.id === selectedId);
  const recipientBalance = recipient ? recipientById.get(recipient.id) : undefined;
  const senderBalance = sender ? senderById.get(sender.id) : undefined;
  const nativeSupported = canSignShitcoin(selectedId);
  // ERC-20 path is unlocked only when the user is on the ETH chain AND
  // picked a non-native token. The native ETH path stays through
  // signAndBroadcastShitcoin / signAndBroadcastEth.
  const erc20Token: Erc20Token | undefined =
    selectedId === 'ETH' && selectedTokenSymbol !== 'ETH'
      ? findErc20Token(selectedTokenSymbol)
      : undefined;
  // Display strings — when the user has selected a token, surface the
  // token's symbol/name everywhere instead of the chain's. E.g. "amount in
  // USDT" rather than "amount in ETH". Recipient address + balance still
  // come from the ETH chain (USDT lives on the same address) — only the
  // unit-of-account changes.
  const assetTicker = erc20Token ? erc20Token.symbol : recipient.ticker;
  const assetName = erc20Token ? erc20Token.name : recipient.name;

  // When an ERC-20 is selected, fetch the recipient + sender balances for
  // that specific token. The native ETH balance already comes from
  // `useShitcoinBalances`; we only need the extra query for tokens.
  const recipientErc20Balance = useQuery({
    queryKey: ['erc20-balance', erc20Token?.symbol ?? '', recipient.address],
    queryFn: ({ signal }) => fetchErc20Balance(erc20Token!, recipient.address, signal),
    enabled: !!erc20Token,
    staleTime: 60_000,
  });
  const senderErc20Balance = useQuery({
    queryKey: ['erc20-balance', erc20Token?.symbol ?? '', sender?.address ?? ''],
    queryFn: ({ signal }) => fetchErc20Balance(erc20Token!, sender!.address, signal),
    enabled: !!erc20Token && !!sender,
    staleTime: 60_000,
  });
  // Compute whole-coin display amounts. For ERC-20s, use the token's
  // decimals; for native chains, use the existing balance hook's value.
  const recipientDisplayAmount = erc20Token
    ? Number(recipientErc20Balance.data ?? 0n) / 10 ** erc20Token.decimals
    : (recipientBalance?.amount ?? 0);
  const senderDisplayAmount = erc20Token
    ? Number(senderErc20Balance.data ?? 0n) / 10 ** erc20Token.decimals
    : (senderBalance?.amount ?? 0);

  // Reset send state whenever the user switches chains so a previous
  // success or error doesn't follow them around.
  const switchChain = (id: ShitcoinId) => {
    setSelectedId(id);
    setSelectedTokenSymbol('ETH'); // reset token to native when switching chains
    setError(null);
    setSuccess(null);
  };
  const switchToken = (sym: string) => {
    setSelectedTokenSymbol(sym);
    setError(null);
    setSuccess(null);
  };

  if (!recipient) {
    return (
      <div className="grid gap-3 px-4 py-6 w-full text-center text-sm text-muted-foreground">
        <p>could not derive shitcoin addresses for this npub. sad.</p>
      </div>
    );
  }

  const uri = shitcoinUri(recipient, amount.trim() || undefined);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recipient.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable
    }
  };

  const handleSend = async () => {
    if (!nativeSupported || !sender || !recipient) return;
    if (!isNsecLogin || senderLogin?.type !== 'nsec') {
      setError('Native shitcoin signing requires an nsec login.');
      return;
    }
    const amtNum = Number(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      const decoded = nip19.decode(senderLogin.data.nsec);
      if (decoded.type !== 'nsec') throw new Error('Bad nsec in login data');
      const privateKey = decoded.data as Uint8Array;

      // Atomic-units decimals per chain/token. BTC-likes use 1e8 sats-
      // equivalents, native ETH uses 1e18 wei, ERC-20 uses the token's own
      // decimals (USDT=6, USDC=6, DAI=18, etc.). Parse via string to avoid
      // float precision loss at 18 decimals.
      const decimals = erc20Token
        ? erc20Token.decimals
        : selectedId === 'ETH'
          ? 18
          : 8;
      const amountAtomic = parseAtomicUnits(amount, decimals);

      const result = erc20Token
        ? await signAndBroadcastErc20({
            token: erc20Token,
            privateKey,
            fromAddress: sender.address,
            toAddress: recipient.address,
            amount: amountAtomic,
          })
        : await signAndBroadcastShitcoin({
            chain: selectedId,
            privateKey,
            fromAddress: sender.address,
            toAddress: recipient.address,
            amount: amountAtomic,
          });
      setSuccess(result);

      // Publish a kind 8333 receipt so the shitcoin zap surfaces under the
      // target post the same way BTC on-chain zaps do. The `i` tag carries
      // the chain prefix (`dogecoin:tx:<txid>` etc.) so consumers that want
      // to distinguish chains can — Magikarp's existing kind-8333 rendering
      // is chain-agnostic at the amount/p/e/amount level, so this slots in
      // without touching the post-zap pipeline.
      try {
        const isAddressable = target.kind >= 30000 && target.kind < 40000;
        const tags: string[][] = [
          ['i', `${recipient.coingeckoId}:tx:${result.txid}`],
          ['p', recipientPubkey],
          ['amount', amountAtomic.toString()],
          ['chain', recipient.ticker],
          ['e', target.id],
        ];
        if (erc20Token) {
          // Carries the ERC-20 symbol so the post-zap renderer can override
          // the chain's ticker / decimals / emoji with the token's.
          tags.push(['token', erc20Token.symbol]);
        }
        if (isAddressable) {
          const dTag = target.tags.find(([n]) => n === 'd')?.[1] ?? '';
          tags.push(['a', `${target.kind}:${target.pubkey}:${dTag}`]);
        }
        const altTicker = erc20Token ? erc20Token.symbol : recipient.ticker;
        const altName = erc20Token ? erc20Token.name : recipient.name;
        tags.push([
          'alt',
          `Shitcoin zap: ${amount} ${altTicker} (${altName})`,
        ]);
        await publishEvent({
          kind: 8333,
          content: '',
          tags,
        });
        queryClient.invalidateQueries({ queryKey: ['onchain-zaps'] });
        queryClient.invalidateQueries({ queryKey: ['event-interactions'] });
        queryClient.setQueryData(['user-zap', target.id], true);
      } catch (publishErr) {
        // The chain broadcast succeeded — the kind 8333 receipt is best-
        // effort. We surface the publish error in console so it isn't
        // silent, but don't overwrite the success state.
        console.warn('shitcoin kind 8333 publish failed:', publishErr);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleOpenWallet = () => {
    if (uri) openUrl(uri);
  };

  // ── Success screen ────────────────────────────────────────────
  if (success) {
    return (
      <div className="grid gap-4 px-4 py-6 w-full text-center">
        <div className="mx-auto rounded-full bg-green-500/15 p-3 w-fit">
          <Check className="size-8 text-green-600" />
        </div>
        <div>
          <p className="text-lg font-semibold" style={{ fontFamily: DOGE_FONT }}>
            sent. much wow.
          </p>
          <p className="text-xs text-muted-foreground pt-1" style={{ fontFamily: DOGE_FONT }}>
            broadcast on {assetName}. kind 8333 receipt published — the zap will
            surface under the post.
          </p>
        </div>
        <div className="flex flex-col gap-2 items-stretch">
          <a
            href={success.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            view tx on explorer
            <ExternalLink className="size-3.5" />
          </a>
          <p className="text-[11px] font-mono break-all text-muted-foreground">
            {success.txid}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setSuccess(null);
            setAmount('');
          }}
        >
          send another
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      {/* Chain picker — DOGE first. 4-col on top row, 3 on bottom for 7 items. */}
      <ToggleGroup
        type="single"
        value={selectedId}
        onValueChange={(v) => v && switchChain(v as ShitcoinId)}
        className="grid grid-cols-4 gap-1 w-full"
      >
        {recipientWallets.map((w) => (
          <ToggleGroupItem
            key={w.id}
            value={w.id}
            className="h-9 min-w-0 text-xs font-semibold px-1 gap-1"
            style={w.id === 'DOGE' ? { fontFamily: DOGE_FONT } : undefined}
          >
            <span aria-hidden>{w.emoji}</span>
            {w.ticker}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* ERC-20 sub-picker — surfaces native ETH + every token in the
          registry whenever the user is on the ETH chain. Lets a single
          npub's ETH address double as a USDT / USDC / DAI / SHIB / PEPE
          wallet without any extra UX. */}
      {selectedId === 'ETH' && (
        <ToggleGroup
          type="single"
          value={selectedTokenSymbol}
          onValueChange={(v) => v && switchToken(v)}
          className="grid grid-cols-3 gap-1 w-full"
        >
          <ToggleGroupItem value="ETH" className="h-8 min-w-0 text-[11px] font-semibold px-1 gap-1">
            <span aria-hidden>🦄</span>
            ETH
          </ToggleGroupItem>
          {ERC20_TOKENS.map((t) => (
            <ToggleGroupItem
              key={t.symbol}
              value={t.symbol}
              className="h-8 min-w-0 text-[11px] font-semibold px-1 gap-1"
            >
              <span aria-hidden>{t.emoji}</span>
              {t.symbol}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {/* Selected chain header */}
      <div className="flex flex-col items-center pt-1">
        <div className="flex items-center gap-1.5">
          {selectedId === 'DOGE' && <Rocket className="size-4 text-yellow-500" />}
          <span
            className="text-lg font-semibold"
            style={selectedId === 'DOGE' ? { fontFamily: DOGE_FONT, color: 'rgb(202 138 4)' } : undefined}
          >
            Send {assetName}
          </span>
          {selectedId === 'DOGE' && <Rocket className="size-4 text-yellow-500 -scale-x-100" />}
        </div>
        <span
          className="text-[11px] text-muted-foreground italic"
          style={{ fontFamily: DOGE_FONT }}
        >
          {recipient.tagline}
        </span>
      </div>

      {/* Balance trio: your balance, recipient balance, native-or-not badge */}
      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-md border px-2 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground" style={{ fontFamily: DOGE_FONT }}>
            ur balance
          </p>
          <p className="text-sm font-medium tabular-nums" style={{ fontFamily: DOGE_FONT }}>
            {formatShitcoinAmount(senderDisplayAmount, selectedId)} {assetTicker}
          </p>
          <p className="text-[10px] text-muted-foreground" style={{ fontFamily: DOGE_FONT }}>
            {erc20Token ? '—' : formatShitcoinUsd(senderBalance?.usd)}
          </p>
        </div>
        <div className="rounded-md border px-2 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground" style={{ fontFamily: DOGE_FONT }}>
            recipient
          </p>
          <p className="text-sm font-medium tabular-nums" style={{ fontFamily: DOGE_FONT }}>
            {formatShitcoinAmount(recipientDisplayAmount, selectedId)} {assetTicker}
          </p>
          <p className="text-[10px] text-muted-foreground" style={{ fontFamily: DOGE_FONT }}>
            {erc20Token ? '—' : formatShitcoinUsd(recipientBalance?.usd)}
          </p>
        </div>
      </div>

      {/* Recipient address row (read-only) */}
      <div className="flex gap-2 min-w-0">
        <Input
          value={recipient.address}
          readOnly
          aria-label={`Recipient's ${recipient.name} address`}
          className="font-mono text-xs min-w-0 flex-1 overflow-hidden text-ellipsis"
          onClick={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleCopy}
          className="shrink-0"
          aria-label="Copy address"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* QR code — encodes the URI deeplink if available, else the bare address.
          For native-signing chains we still show this so users can scan from
          another wallet if they prefer that flow. */}
      <div className="flex justify-center">
        <div className="bg-white p-3 rounded-xl" aria-label={`${recipient.name} address QR code`}>
          <QRCodeCanvas value={uri ?? recipient.address} size={160} level="M" className="block" />
        </div>
      </div>

      {/* Amount input — needed both for the URI deeplink and the native send. */}
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={amount}
        onChange={(e) => { setAmount(e.target.value); setError(null); }}
        placeholder={`amount in ${assetTicker}`}
        aria-label={`Amount in ${assetTicker}`}
        className="text-sm"
      />

      {error && (
        <p className="text-xs text-destructive text-center" style={{ fontFamily: DOGE_FONT }}>
          {error}
        </p>
      )}

      {/* Primary action — native send if supported and the user has an nsec,
          else the deeplink fallback, else honest "can't sign on this chain". */}
      {nativeSupported && isNsecLogin ? (
        <Button
          type="button"
          onClick={handleSend}
          disabled={sending || !amount || Number(amount) <= 0}
          className="w-full"
          variant={selectedId === 'DOGE' ? 'default' : 'outline'}
        >
          {sending ? (
            <>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              signing + broadcasting…
            </>
          ) : (
            <span style={{ fontFamily: DOGE_FONT }}>
              send {amount || '0'} {assetTicker} to npub
            </span>
          )}
        </Button>
      ) : nativeSupported && !isNsecLogin ? (
        <div className="space-y-2">
          <Button type="button" disabled className="w-full">
            <span style={{ fontFamily: DOGE_FONT }}>
              nsec required for native {recipient.name} signing
            </span>
          </Button>
          {uri && (
            <Button type="button" variant="outline" onClick={handleOpenWallet} className="w-full">
              <ExternalLink className="h-4 w-4 mr-2" />
              <span style={{ fontFamily: DOGE_FONT }}>
                open in {recipient.name} wallet instead
              </span>
            </Button>
          )}
        </div>
      ) : uri ? (
        <div className="space-y-2">
          <Button type="button" variant="outline" onClick={handleOpenWallet} className="w-full">
            <ExternalLink className="h-4 w-4 mr-2" />
            <span style={{ fontFamily: DOGE_FONT }}>
              open in {recipient.name} wallet
            </span>
          </Button>
          <p className="text-[11px] text-muted-foreground text-center" style={{ fontFamily: DOGE_FONT }}>
            native {recipient.name} signing not shipped in this fork (yet) — needs its own pipeline
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center" style={{ fontFamily: DOGE_FONT }}>
          no URI scheme + no native signer for {recipient.name} — copy the address and
          paste it into a wallet (Keplr / Leap / etc.)
        </p>
      )}

      {/* The truth-telling disclaimer that makes the joke land */}
      <p
        className="text-[11px] leading-relaxed text-muted-foreground/80 text-center pt-1"
        style={{ fontFamily: DOGE_FONT }}
      >
        {nativeSupported
          ? `magikarp signs ${assetName} natively from ur nsec + publishes a kind 8333 receipt so the zap appears under the post.`
          : `${assetName} signing needs its own pipeline (different sighash / encoding). wen? wen u send a PR bro.`}
      </p>
    </div>
  );
}
