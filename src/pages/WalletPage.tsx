import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import { Bitcoin, Copy, Check, RefreshCw, Wallet, ChevronDown, ArrowDownLeft, ArrowUpRight, Send, Rocket, ExternalLink, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/PageHeader';
import { LoginArea } from '@/components/auth/LoginArea';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { SendBitcoinDialog } from '@/components/SendBitcoinDialog';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useBitcoinWallet } from '@/hooks/useBitcoinWallet';
import { useShitcoinAddresses } from '@/hooks/useShitcoinAddresses';
import { useShitcoinBalances } from '@/hooks/useShitcoinBalances';
import { satsToUSD, formatBTC } from '@/lib/bitcoin';
import { shitcoinUri } from '@/lib/shitcoins';
import { formatShitcoinAmount, formatShitcoinUsd } from '@/lib/shitcoinBalances';
import type { Transaction } from '@/lib/bitcoin';
import type { ShitcoinWallet } from '@/lib/shitcoins';

/**
 * The font stack that gives the shitcoin section its Doge-meme aesthetic.
 * Comic Neue is the webfont preferred form (already on the theme list); the
 * system Comic Sans variants and cursive default cover unloaded states so the
 * joke always lands even before the webfont resolves.
 */
const DOGE_FONT = '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive, sans-serif';

/**
 * Shape of `location.state` consumed by this page when arriving via a
 * `bitcoin:` deep link. The `DeepLinkHandler` navigates to `/wallet` with
 * `state: { bip21Uri }` so we can auto-open the Send dialog with the URI
 * prefilled. Kept here (rather than exported) because no other route
 * produces this state.
 */
interface WalletLocationState {
  bip21Uri?: string;
}

export function WalletPage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { bitcoinAddress, addressData, btcPrice, transactions, isLoading, error, refetch } = useBitcoinWallet();
  const { wallets: shitcoinWallets } = useShitcoinAddresses();
  const { joined: shitcoinBalances } = useShitcoinBalances(shitcoinWallets);

  const location = useLocation();
  const navigate = useNavigate();
  const locationState = location.state as WalletLocationState | null;

  const [copiedAddress, setCopiedAddress] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [shitcoinsOpen, setShitcoinsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  // Snapshot of the URI we opened with. We snapshot once (rather than reading
  // `locationState?.bip21Uri` on every render) so clearing `location.state`
  // after consumption doesn't blank out the dialog's `initialUri` prop while
  // it's still open.
  const [pendingUri, setPendingUri] = useState<string | undefined>(undefined);
  const consumedDeepLinkRef = useRef(false);

  // Auto-open the Send dialog when the user arrived via a `bitcoin:` deep
  // link. Only fires once per navigation; we then clear `location.state` so
  // a back-then-forward navigation, or a refresh, doesn't relaunch the
  // dialog. Logged-out users get the login prompt instead — no point opening
  // a Send dialog they can't use.
  useEffect(() => {
    if (consumedDeepLinkRef.current) return;
    const uri = locationState?.bip21Uri;
    if (!uri) return;
    consumedDeepLinkRef.current = true;
    if (user) {
      setPendingUri(uri);
      setSendOpen(true);
    }
    // Strip the URI from history state so it doesn't replay on back-forward.
    navigate(location.pathname, { replace: true, state: null });
  }, [locationState, user, navigate, location.pathname]);

  useSeoMeta({
    title: `Wallet | ${config.appName}`,
    description: 'Your Bitcoin Taproot wallet — plus DOGE, LTC, BCH, BSV, ETH, ZEC, and ATOM. Every npub is every wallet. Cross-chain integration enabled. Wen moon.',
  });

  const copyAddress = async () => {
    if (!bitcoinAddress) return;
    try {
      await navigator.clipboard.writeText(bitcoinAddress);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const truncatedAddress = bitcoinAddress
    ? `${bitcoinAddress.slice(0, 12)}...${bitcoinAddress.slice(-8)}`
    : '';

  return (
    <main>
      <PageHeader title="Wallet" icon={<Wallet className="size-5" />} />

      {!user ? (
        <div className="py-20 px-8 flex flex-col items-center gap-6 text-center">
          <div className="p-4 rounded-full bg-primary/10">
            <Bitcoin className="size-8 text-primary" />
          </div>
          <div className="space-y-2 max-w-xs">
            <h2 className="text-xl font-bold">Your Bitcoin Wallet</h2>
            <p className="text-muted-foreground text-sm">
              Log in to see your Bitcoin Taproot address derived from your Nostr identity.
            </p>
          </div>
          <LoginArea className="max-w-60" />
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 pt-8 pb-4 space-y-6 max-w-sm mx-auto">
          {/* Balance */}
          {isLoading ? (
            <div className="flex flex-col items-center space-y-2">
              <Skeleton className="h-10 w-40 rounded-lg" />
              <Skeleton className="h-4 w-24 rounded" />
            </div>
          ) : error ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-destructive">Failed to load balance</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="size-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          ) : addressData ? (
            <div className="flex flex-col items-center space-y-1">
              <span className="text-4xl font-bold tracking-tight">
                {btcPrice
                  ? satsToUSD(addressData.totalBalance, btcPrice)
                  : '---'}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatBTC(addressData.totalBalance)} BTC
              </span>

              {addressData.pendingBalance !== 0 && (
                <span className="flex items-center gap-1 text-xs text-orange-500 dark:text-orange-400 pt-1">
                  <RefreshCw className="size-3 animate-spin" />
                  {btcPrice
                    ? `${satsToUSD(addressData.pendingBalance, btcPrice)} pending`
                    : 'pending'}
                </span>
              )}
            </div>
          ) : null}

          {/* Send button */}
          {addressData && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSendOpen(true)}
              className="rounded-full"
            >
              <Send className="size-3.5 mr-1.5" />
              Send
            </Button>
          )}

          <SendBitcoinDialog
            isOpen={sendOpen}
            onClose={() => {
              setSendOpen(false);
              setPendingUri(undefined);
            }}
            btcPrice={btcPrice}
            initialUri={pendingUri}
          />

          {/* QR Code */}
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <QRCodeCanvas value={bitcoinAddress} size={200} level="M" />
          </div>

          {/* Address + copy */}
          <button
            onClick={copyAddress}
            className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-mono text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          >
            {truncatedAddress}
            {copiedAddress ? (
              <Check className="size-3.5 text-green-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>

          {/* Transactions */}
          {transactions && transactions.length > 0 && (
            <>
              <button
                onClick={() => setTxOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Transactions
                <ChevronDown className={`size-3 transition-transform duration-200 ${txOpen ? 'rotate-180' : ''}`} />
              </button>

              <TxAccordion open={txOpen}>
                <div className="w-full divide-y">
                  {transactions.map((tx) => (
                    <TxRow key={tx.txid} tx={tx} btcPrice={btcPrice} />
                  ))}
                </div>
              </TxAccordion>
            </>
          )}

          {/* Cross-Chain Integration™ — every npub is also a wallet on seven
              other chains. DOGE is promoted to a featured card because it is,
              definitionally, the number one shitcoin. The remaining six live
              in the "Other Shitcoins" accordion below. */}
          {shitcoinWallets.length > 0 && (() => {
            const balanceById = new Map(shitcoinBalances.map((b) => [b.wallet.id, b]));
            const doge = shitcoinWallets.find((w) => w.id === 'DOGE');
            const dogeBalance = doge ? balanceById.get(doge.id) : undefined;
            const others = shitcoinWallets.filter((w) => w.id !== 'DOGE');
            return (
              <div className="w-full pt-6 space-y-6">
                {/* Banner */}
                <div className="text-center space-y-1">
                  <p
                    className="text-xs uppercase tracking-[0.2em] text-muted-foreground"
                    style={{ fontFamily: DOGE_FONT }}
                  >
                    Cross-Chain Integration Enabled
                  </p>
                  <p
                    className="text-[11px] text-muted-foreground/70"
                    style={{ fontFamily: DOGE_FONT }}
                  >
                    your npub is also: 7 other wallets. you're welcome.
                  </p>
                </div>

                {/* Featured: DOGE — much wallet, very chain */}
                {doge && (
                  <DogeFeaturedCard
                    wallet={doge}
                    amount={dogeBalance?.amount ?? 0}
                    usd={dogeBalance?.usd}
                  />
                )}

                {/* The long tail */}
                {others.length > 0 && (
                  <div className="w-full pt-2">
                    <button
                      onClick={() => setShitcoinsOpen((o) => !o)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer mx-auto"
                      style={{ fontFamily: DOGE_FONT }}
                    >
                      other shitcoins (u have these too bro)
                      <ChevronDown className={`size-3 transition-transform duration-200 ${shitcoinsOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <TxAccordion open={shitcoinsOpen}>
                      <div className="w-full pt-3 space-y-2">
                        <div className="w-full divide-y">
                          {others.map((w) => {
                            const b = balanceById.get(w.id);
                            return (
                              <ShitcoinRow
                                key={w.id}
                                wallet={w}
                                amount={b?.amount ?? 0}
                                usd={b?.usd}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </TxAccordion>
                  </div>
                )}

                {/* The "how to spend" footer — snarky but technically truthful */}
                <p
                  className="text-[11px] leading-relaxed text-muted-foreground/70 text-center px-4 pt-2"
                  style={{ fontFamily: DOGE_FONT }}
                >
                  wen u want to actually spend: export ur nsec, negate if y-parity is odd
                  (signingKey = (n − d) mod n), import as a WIF / EVM private key into a
                  real wallet for that chain. trust me bro.
                </p>
              </div>
            );
          })()}

          <WhyThisIsTerrible />
        </div>
      )}
    </main>
  );
}

/**
 * The serious counterweight to everything above. The cross-chain section is a
 * joke about the absurdity of mapping one public key to eight chains; this
 * block is the explanation of *why* it's a joke — and why on-chain zaps, the
 * whole reason this scheme is technically possible, are an awful idea in
 * practice. Always visible. Destructive-themed so it visually breaks from
 * the rest of the page and cannot be confused for more bit.
 */
function WhyThisIsTerrible() {
  return (
    <section className="w-full pt-10 mt-6 border-t border-destructive/30 space-y-6">
      <header className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-destructive/50 bg-destructive/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive">
          <AlertTriangle className="size-3.5" />
          Stop. Read this first.
        </div>
        <h2 className="text-lg font-bold">
          Why this entire page is a terrible idea
        </h2>
        <p className="text-xs text-muted-foreground italic max-w-sm mx-auto">
          The memes above are a joke. The warning below is not. If you take one
          thing from this wallet, take this section.
        </p>
      </header>

      <div className="space-y-7 text-sm leading-relaxed">
        {/* ── Section 1: Why this is a terrible idea ─────────────────── */}
        <article className="space-y-3">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <span className="text-destructive">1.</span>
            Why deriving a wallet from your npub is a terrible idea
          </h3>
          <p className="text-muted-foreground">
            Every Nostr keypair maps to exactly one Bitcoin Taproot address —
            and, on this page, to seven other chains. That sounds convenient.
            It is, in fact, one of the worst design choices you can make for
            financial privacy and operational security.
          </p>
          <p className="text-muted-foreground">
            Your npub is public. It is on every relay, in every profile
            lookup, in every reply you have ever made. Once anyone derives
            your address from your npub (which any client can do in
            milliseconds), your entire on-chain history is permanently and
            publicly attached to your social identity. Forever. The
            blockchain doesn't forget. There is no "deactivate account."
          </p>
          <p className="text-muted-foreground">
            Worse: this isn't one address per receive — it is{' '}
            <em>the</em> address, reused for every payment that ever lands.
            Address reuse is the cardinal sin of Bitcoin privacy. It
            collapses what should be a forest of disconnected UTXOs into a
            single, perfectly clustered, perfectly identified wallet. Chain
            analysis firms charge enterprise rates to do this clustering
            inference. This scheme just hands them the answer key.
          </p>
          <p className="text-muted-foreground">
            And the same key signs your Nostr posts <em>and</em> spends your
            Bitcoin. There is no recovery, no rotation, no separation of
            concerns. A single compromise — a leaked nsec, a malicious
            extension, a keylogger — loses your social identity and your
            funds on eight chains simultaneously, in one event, with no
            undo.
          </p>
        </article>

        {/* ── Section 2: Why privacy matters ──────────────────────────── */}
        <article className="space-y-3">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <span className="text-destructive">2.</span>
            Why privacy matters
          </h3>
          <p className="text-muted-foreground">
            Financial privacy isn't about hiding wrongdoing. It is about not
            handing every present and future adversary a complete dossier of
            your economic life. Specifically:
          </p>
          <ul className="space-y-1.5 text-muted-foreground list-disc pl-5">
            <li>Your employer cannot see which causes, churches, unions, or political campaigns you donate to.</li>
            <li>Your government cannot see how much you hold when it decides whom to audit, freeze, sanction, or detain.</li>
            <li>Your ex cannot see who pays you, or what for.</li>
            <li>A stalker cannot watch your money move — and, through exchange withdrawals, infer where you physically are.</li>
            <li>Strangers cannot compute your net worth from a profile click.</li>
            <li>You don't paint a target on your back for kidnappers. The "$5 wrench attack" on visibly wealthy crypto holders is real, rising, and lethal.</li>
            <li>Every counterparty you have ever transacted with does not become a publicly discoverable associate of yours.</li>
            <li>You do not surrender every future version of yourself to a permanent, immutable, world-readable ledger maintained by adversaries you can't predict.</li>
          </ul>
          <p className="text-muted-foreground">
            Bitcoin is pseudonymous by default and private only with
            deliberate effort: fresh addresses per invoice, coinjoin,
            payjoin, silent payments, Lightning. This scheme deliberately
            throws all of that away. It takes the worst property of Bitcoin
            (a transparent, append-only ledger that survives you) and pairs
            it with the worst property of social media (a single
            world-readable public identifier) and then ships it as a
            feature.
          </p>
          <p className="text-muted-foreground">
            The seven non-Bitcoin chains above are <em>worse</em>. Ethereum,
            Dogecoin, Litecoin, BCH, BSV, ZEC's transparent addresses,
            Cosmos — every transaction, every balance, every counterparty,
            in clear text, forever, deterministically linked to your npub.
            Some of those chains have no realistic privacy tooling at all.
          </p>
        </article>

        {/* ── Section 3: Why on-chain zaps are TERRIBLE ───────────────── */}
        <article className="space-y-3">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <span className="text-destructive">3.</span>
            Why on-chain zaps are TERRIBLE in every way
          </h3>
          <p className="text-muted-foreground">
            The premise of a zap is a tiny, instant, expressive payment — a
            like with skin in the game. Bitcoin's base layer cannot do this.
            Not because it is underdeveloped, but because it was never meant
            to. Pushing zaps onto L1 breaks on every axis that matters:
          </p>
          <ul className="space-y-2 text-muted-foreground list-disc pl-5">
            <li>
              <strong className="text-foreground">Fees.</strong> A typical
              on-chain transaction costs anywhere from a few cents to several
              dollars in mining fees. A 21-sat "love it" zap costs more in
              fees than the zap itself — often by a factor of a thousand.
              Lightning fees are sub-satoshi.
            </li>
            <li>
              <strong className="text-foreground">Latency.</strong> First
              confirmation: ~10 minutes. Reasonable finality: ~60 minutes.
              Interactive tipping needs sub-second settlement. Lightning
              provides this. L1 cannot.
            </li>
            <li>
              <strong className="text-foreground">Throughput.</strong>{' '}
              Bitcoin processes roughly 7 transactions per second, globally,
              total. A single popular post can attract thousands of zaps
              per minute. On-chain zaps don't scale; they evict actual
              settlement transactions from blocks.
            </li>
            <li>
              <strong className="text-foreground">Permanence.</strong> Every
              zap — every dust amount, every petty squabble paid out — is
              etched into every full node, every archive node, every block
              explorer, forever, on every continent. There is no delete.
            </li>
            <li>
              <strong className="text-foreground">Dust UTXOs.</strong>{' '}
              Receiving 100 sats creates a UTXO that costs more to spend
              than it contains. Your wallet fills with unspendable
              splinters. The sender is paying you with a permanent liability.
            </li>
            <li>
              <strong className="text-foreground">
                No memo, no invoice, no amount negotiation.
              </strong>{' '}
              The chain doesn't carry message data. There is no expiry. No
              "wait, wrong amount." Fat-finger an extra zero and the funds
              are gone in ten minutes.
            </li>
            <li>
              <strong className="text-foreground">No refunds.</strong> A
              failed Lightning payment refunds atomically in seconds. A
              misdirected on-chain payment refunds when the recipient feels
              like it. If ever.
            </li>
            <li>
              <strong className="text-foreground">
                Censorship and surveillance.
              </strong>{' '}
              Miners see every transaction. Mining pools are increasingly
              regulated and increasingly willing to filter the mempool. Your
              zap is OFAC-screened before it confirms.
            </li>
            <li>
              <strong className="text-foreground">Forced address reuse.</strong>{' '}
              Lightning hides recipient identity entirely. Silent Payments
              rotate per-payment. BIP-32 wallets rotate per-invoice.
              On-chain zaps to derived npub addresses reuse the same
              address, every time, for every payment, from every sender. It
              is the worst possible address-management discipline, made
              mandatory.
            </li>
            <li>
              <strong className="text-foreground">
                Permanent social-graph leak.
              </strong>{' '}
              Every zap is a public, signed, timestamped link between two
              npubs <em>and</em> two on-chain identities. You are
              constructing, on your own initiative, a court-admissible
              social graph in a public registry.
            </li>
            <li>
              <strong className="text-foreground">
                Chain analysis as a service.
              </strong>{' '}
              The npub-to-address mapping is deterministic and
              well-documented. Every chain-analysis firm on earth gets a
              free clustering oracle. There is no opting out — except by
              not using this.
            </li>
          </ul>
          <p className="text-muted-foreground">
            Lightning exists. NIP-57 exists. They were designed for this
            problem and they solve it. Kind 8333 on-chain zaps were
            designed as a thought experiment about what happens when you
            don't use them. Treat them accordingly.
          </p>
        </article>

        {/* Closing — bring the snark back, but only after the lesson lands. */}
        <p className="text-[11px] text-muted-foreground/70 italic text-center pt-2">
          tl;dr: the "Cross-Chain Integration™" banner above is a joke. The
          bullet points here are not. If you actually want to tip someone on
          Nostr, use a Lightning zap.
        </p>
      </div>
    </section>
  );
}

/**
 * The number-one-shitcoin tile. Mirrors the BTC wallet block above
 * (balance-shaped header → QR → address pill) but in full Doge regalia.
 * Intentionally side-by-side with BTC in visual weight: the joke is that
 * Magikarp now treats DOGE as a first-class peer.
 */
function DogeFeaturedCard({
  wallet,
  amount,
  usd,
}: {
  wallet: ShitcoinWallet;
  amount: number;
  usd: number | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const truncated = `${wallet.address.slice(0, 12)}...${wallet.address.slice(-8)}`;
  const uri = shitcoinUri(wallet);

  return (
    <div className="w-full rounded-2xl border-2 border-yellow-400/60 bg-gradient-to-b from-yellow-400/10 to-amber-500/5 p-5 space-y-4">
      {/* Header — "Dogecoin" in Comic Sans with the gold rocket */}
      <div className="flex flex-col items-center space-y-1">
        <div className="flex items-center gap-2">
          <Rocket className="size-5 text-yellow-500" />
          <span
            className="text-2xl font-bold text-yellow-600 dark:text-yellow-400"
            style={{ fontFamily: DOGE_FONT }}
          >
            Dogecoin
          </span>
          <Rocket className="size-5 text-yellow-500 -scale-x-100" />
        </div>
        <span
          className="text-xs uppercase tracking-[0.18em] text-yellow-700/80 dark:text-yellow-300/80"
          style={{ fontFamily: DOGE_FONT }}
        >
          The #1 Shitcoin
        </span>
        <span
          className="text-[11px] text-muted-foreground italic"
          style={{ fontFamily: DOGE_FONT }}
        >
          {wallet.tagline}
        </span>
      </div>

      {/* Balance — mimics the BTC balance display above (big USD on top,
          coin amount underneath) so DOGE reads as a first-class wallet. */}
      <div className="flex flex-col items-center -mt-1">
        <span
          className="text-3xl font-bold tracking-tight"
          style={{ fontFamily: DOGE_FONT }}
        >
          {formatShitcoinUsd(usd)}
        </span>
        <span
          className="text-sm text-muted-foreground"
          style={{ fontFamily: DOGE_FONT }}
        >
          {formatShitcoinAmount(amount, wallet.id)} {wallet.ticker}
        </span>
      </div>

      {/* QR — same white card treatment as the BTC QR for visual parity */}
      <div className="flex justify-center">
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <QRCodeCanvas value={uri ?? wallet.address} size={180} level="M" />
        </div>
      </div>

      {/* Address pill */}
      <div className="flex justify-center">
        <button
          onClick={copy}
          className="flex items-center gap-2 rounded-full border border-yellow-400/40 px-4 py-2 text-sm font-mono text-muted-foreground hover:bg-yellow-400/10 transition-colors cursor-pointer"
        >
          {truncated}
          {copied ? (
            <Check className="size-3.5 text-green-500" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>

      {/* Open-in-wallet deeplink */}
      {uri && (
        <div className="flex justify-center">
          <a
            href={uri}
            className="inline-flex items-center gap-1.5 text-xs text-yellow-700 dark:text-yellow-300 hover:underline"
            style={{ fontFamily: DOGE_FONT }}
          >
            open in doge wallet
            <ExternalLink className="size-3" />
          </a>
        </div>
      )}

      <p
        className="text-[11px] text-center text-muted-foreground/80 px-2"
        style={{ fontFamily: DOGE_FONT }}
      >
        anyone can zap u doge by knowing only ur npub. much zap. very onchain. no LNURL.
      </p>
    </div>
  );
}

/** A single derived shitcoin address row — copy-to-clipboard, plus a
 *  per-chain "open in wallet" deeplink when the chain has a URI scheme.
 *  Shows balance + USD on the right when available. */
function ShitcoinRow({
  wallet,
  amount,
  usd,
}: {
  wallet: ShitcoinWallet;
  amount: number;
  usd: number | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const truncated = wallet.address.length > 24
    ? `${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`
    : wallet.address;
  const uri = shitcoinUri(wallet);

  return (
    <div className="w-full flex items-center justify-between gap-3 py-3 px-2 -mx-1 hover:bg-muted/50 transition-colors rounded-lg">
      <button
        onClick={copy}
        className="flex-1 min-w-0 text-left cursor-pointer"
      >
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium">
            <span className="mr-1" aria-hidden>{wallet.emoji}</span>
            {wallet.name}
          </p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{wallet.ticker}</p>
        </div>
        <p
          className="text-[11px] text-muted-foreground/80 italic truncate"
          style={{ fontFamily: DOGE_FONT }}
        >
          {wallet.tagline}
        </p>
        <p className="text-xs font-mono text-muted-foreground truncate pt-0.5">{truncated}</p>
      </button>
      <div className="flex items-center gap-3 shrink-0">
        {/* Balance / USD column */}
        <div className="text-right">
          <p
            className="text-xs font-medium tabular-nums"
            style={{ fontFamily: DOGE_FONT }}
          >
            {formatShitcoinUsd(usd)}
          </p>
          <p
            className="text-[10px] text-muted-foreground tabular-nums"
            style={{ fontFamily: DOGE_FONT }}
          >
            {formatShitcoinAmount(amount, wallet.id)} {wallet.ticker}
          </p>
        </div>
        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {uri && (
            <a
              href={uri}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label={`Open in ${wallet.name} wallet`}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          <button
            onClick={copy}
            aria-label={`Copy ${wallet.name} address`}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            {copied ? (
              <Check className="size-3.5 text-green-500" />
            ) : (
              <Copy className="size-3.5 text-muted-foreground" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Accordion wrapper using grid-template-rows for smooth height animation. */
function TxAccordion({ open, children }: { open: boolean; children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="w-full grid transition-[grid-template-rows] duration-300 ease-in-out"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div ref={contentRef} className="overflow-hidden">
        {children}
      </div>
    </div>
  );
}

/** Format a unix timestamp as a relative or absolute date. */
function formatTxDate(timestamp?: number): string {
  if (!timestamp) return 'Pending';

  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Single transaction row. */
function TxRow({ tx, btcPrice }: { tx: Transaction; btcPrice?: number }) {
  const isReceive = tx.type === 'receive';

  return (
    <Link
      to={`/i/bitcoin:tx:${tx.txid}`}
      className="flex items-center justify-between py-3 px-1 hover:bg-muted/50 transition-colors rounded-lg -mx-1 px-2"
    >
      <div className="flex items-center gap-3">
        <div className={`flex items-center justify-center size-8 rounded-full ${
          isReceive
            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
            : 'bg-red-500/10 text-red-600 dark:text-red-400'
        }`}>
          {isReceive
            ? <ArrowDownLeft className="size-4" />
            : <ArrowUpRight className="size-4" />}
        </div>
        <div>
          <p className="text-sm font-medium">{isReceive ? 'Received' : 'Sent'}</p>
          <p className="text-xs text-muted-foreground">{formatTxDate(tx.timestamp)}</p>
        </div>
      </div>
      <div className="text-right">
        <p className={`text-sm font-medium ${
          isReceive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}>
          {isReceive ? '+' : '-'}
          {btcPrice
            ? satsToUSD(tx.amount, btcPrice)
            : `${formatBTC(tx.amount)} BTC`}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatBTC(tx.amount)} BTC
        </p>
      </div>
    </Link>
  );
}
