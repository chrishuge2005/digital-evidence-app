import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export const authService = {
  /**
   * Get the strictly authenticated user session.
   */
  async getSession() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  },

  /**
   * Fetch profile data dynamically from the server.
   * Client caches are ignored for security-critical decisions.
   */
  async getSecureProfile(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, email, display_name, role')
      .eq('user_id', userId)
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Secure Logout Sequence
   * Terminates the Supabase session and removes only app-specific local caches.
   *
   * IMPORTANT: Do NOT call AsyncStorage.clear() here.
   * Supabase stores its session token in AsyncStorage internally.
   * Wiping all of AsyncStorage destroys the session token and causes the
   * "stuck on loading screen after reopen" bug — the app cannot restore
   * the session on next launch because the token is gone.
   */
  async logout(): Promise<void> {
    // 1. Terminate cloud session
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.warn('[AUTH] Supabase signOut warning (non-fatal):', error.message);
      }
    } catch (err: any) {
      console.warn('[AUTH] Supabase signOut exception (non-fatal):', err.message);
      // Do NOT call AsyncStorage.clear() here as a fallback.
      // Supabase signOut failing on the network layer does not mean we
      // should wipe local storage — the token will simply expire naturally.
    }

    // 2. Remove only app-specific cached keys.
    // Never remove Supabase's own auth keys — they are managed by the Supabase client.
    const appKeysToRemove = [
      '@app_session',
      '@user_role',
      '@team_id',
      '@local_evidence_cache',
      '@offline_sync_queue',
      '@local_custody_events',
      '@sync_queue',
    ];

    try {
      await AsyncStorage.multiRemove(appKeysToRemove);
    } catch (err: any) {
      console.warn('[AUTH] Failed to remove app cache keys (non-fatal):', err.message);
      // Still do NOT call AsyncStorage.clear() here.
      // Individual key removal failure is a non-critical warning.
    }
  },
};