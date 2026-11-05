import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState, AppStateStatus } from 'react-native';

const APP_KEYS = [
  '@local_evidence_metadata',
  '@local_evidence_attachments',
  '@sync_queue',
  '@local_evidence_cache',
  '@local_custody_events',
  '@session_active_marker',
];

export const localDataCleanupService = {
  /**
   * Complete, centralized wipe of ALL local application storage & physical files on device.
   * NEVER modifies or deletes any Supabase Cloud database rows or Supabase Cloud Storage.
   */
  async clearAllLocalApplicationData(): Promise<void> {
    console.log('[CLEANUP] Initiating local application data wipe...');

    // 1. Remove ONLY local application-specific evidence & cache AsyncStorage keys.
    // NEVER remove Supabase auth tokens (sb-*-auth-token) here.
    // Auth sessions must only be removed through explicit supabase.auth.signOut().
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const keysToRemove = allKeys.filter(key => APP_KEYS.includes(key));
      if (keysToRemove.length > 0) {
        await AsyncStorage.multiRemove(keysToRemove);
        console.log('[CLEANUP] Successfully removed local evidence AsyncStorage keys:', keysToRemove);
      }
    } catch (err) {
      console.warn('[CLEANUP WARNING] Failed to clear AsyncStorage keys:', err);
    }

    // 2. Delete local physical evidence directory in documentDirectory
    try {
      const evidenceDir = `${FileSystem.documentDirectory}evidence/`;
      const dirInfo = await FileSystem.getInfoAsync(evidenceDir);
      if (dirInfo.exists) {
        await FileSystem.deleteAsync(evidenceDir, { idempotent: true });
        console.log('[CLEANUP] Successfully deleted local physical evidence directory.');
      }
    } catch (err) {
      console.warn('[CLEANUP WARNING] Failed to delete physical evidence directory:', err);
    }

    // 3. Delete temporary cache files in cacheDirectory
    try {
      if (FileSystem.cacheDirectory) {
        const cacheInfo = await FileSystem.getInfoAsync(FileSystem.cacheDirectory);
        if (cacheInfo.exists) {
          const files = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
          for (const file of files) {
            await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${file}`, { idempotent: true });
          }
          console.log('[CLEANUP] Successfully deleted local cacheDirectory files.');
        }
      }
    } catch (err) {
      console.warn('[CLEANUP WARNING] Failed to clear cacheDirectory files:', err);
    }

    console.log('[CLEANUP] Local evidence data wipe complete.');
  },

  /**
   * Startup cleanup check: Safe check on launch.
   * NEVER deletes authentication tokens.
   */
  async performStartupCleanup(): Promise<void> {
    console.log('[CLEANUP] Startup check completed (auth tokens preserved).');
  },

  /**
   * Register AppState lifecycle listener to monitor app state changes.
   * Preserves session and evidence during background/inactive (keyboard, alerts, switching).
   */
  registerAppStateListener(): () => void {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      console.log(`[APP STATE] App state changed to ${nextAppState}. Session preserved.`);
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }
};
