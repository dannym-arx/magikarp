import { useEffect, useMemo } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

import { useCurrentUser } from './useCurrentUser';
import { useAppContext } from './useAppContext';
import { useEncryptedSettings } from './useEncryptedSettings';
import { useFollowList } from './useFollowActions';
import { getEffectiveRelays } from '@/lib/appRelays';
import { getEnabledNotificationKinds } from '@/lib/notificationKinds';

/**
 * Interface for the native notification Capacitor plugin.
 *
 * NOTE: the registration string below MUST stay `'DittoNotification'` — it is
 * the bridge identifier hard-coded in the native Android (`@CapacitorPlugin`)
 * and iOS plugin classes (package `pub.ditto.app`). Renaming it here without
 * renaming the native classes/package would silently break native
 * notifications, so it is intentionally left as the original identifier.
 */
interface MagikarpNotificationPlugin {
  configure(options: { userPubkey?: string; relayUrls?: string[]; enabledKinds?: number[]; authors?: string[]; notificationStyle?: string }): Promise<void>;
}

const MagikarpNotification = registerPlugin<MagikarpNotificationPlugin>('DittoNotification');

/**
 * Manages the native Android notification service via Capacitor.
 *
 * Passes user pubkey + relay URLs + enabled notification kinds + optional
 * authors filter to the MagikarpNotification plugin so it can poll for events
 * in the background. Respects the NIP-78 notificationsEnabled setting
 * (defaults to on), per-type notification preferences, and the "only from
 * people I follow" setting.
 *
 * Web Push (nostr-push) is handled separately by usePushNotifications +
 * NotificationSettings — this hook is Capacitor-only.
 */
export function useNativeNotifications(): void {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { settings } = useEncryptedSettings();
  const { data: followData } = useFollowList();

  const prefs = settings?.notificationPreferences;
  const notificationsEnabled = settings?.notificationsEnabled ?? true;
  const notificationStyle = settings?.notificationStyle ?? 'push';
  const enabledKinds = useMemo(
    () => getEnabledNotificationKinds(prefs),
    [prefs],
  );

  // Authors filter: when onlyFollowing is set, restrict to followed pubkeys
  const followedPubkeys = useMemo(
    () => followData?.pubkeys ?? [],
    [followData?.pubkeys],
  );
  const onlyFollowing = prefs?.onlyFollowing === true;
  const authorsFilter = onlyFollowing && followedPubkeys.length > 0
    ? followedPubkeys
    : undefined;

  // Request native notification permission on first mount.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    (async () => {
      try {
        const { display } = await LocalNotifications.checkPermissions();
        if (display === 'prompt' || display === 'prompt-with-rationale') {
          await LocalNotifications.requestPermissions();
        }
      } catch {
        // Permission check failed — ignore
      }
    })();
  }, []);

  // Configure / deconfigure the native polling service.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    if (!user || !notificationsEnabled) {
      MagikarpNotification.configure({});
      return;
    }

    const effectiveRelays = getEffectiveRelays(config.relayMetadata, config.useAppRelays, config.useUserRelays);
    const relayUrls = effectiveRelays.relays
      .filter((r) => r.read)
      .map((r) => r.url);

    if (relayUrls.length === 0) return;

    MagikarpNotification.configure({
      userPubkey: user.pubkey,
      relayUrls,
      enabledKinds,
      notificationStyle,
      ...(authorsFilter ? { authors: authorsFilter } : {}),
    });
  }, [user, config.relayMetadata, config.useAppRelays, config.useUserRelays, notificationsEnabled, notificationStyle, enabledKinds, authorsFilter]);
}
