import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Network from 'expo-network';
import { syncService } from '../services/syncService';
import { useAuth } from '../contexts/AuthContext';

export function useOfflineSync(syncIntervalMs = 60000) {
  const { user, profile, team } = useAuth();
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let isMounted = true;

    const executeSync = async () => {
      if (appState.current !== 'active' || !isMounted || !user) {
        return;
      }

      try {
        const network = await Network.getNetworkStateAsync();
        if (!network.isConnected) {
          return;
        }

        // 1. Push any pending operations up to the server safely
        await syncService.processQueue();

        // 2. Refresh local device with latest cloud evidence
        const teamId = team?.teamId || (profile as any)?.team_id || (profile as any)?.teamId;
        if (teamId) {
          await syncService.pullLatestData(teamId);
        }
      } catch (err: any) {
        console.warn('[SYNC] Background sync cycle notice (non-fatal):', err?.message || err);
      }
    };

    const startSyncInterval = () => {
      if (!intervalRef.current) {
        executeSync(); // Immediate trigger on foreground
        intervalRef.current = setInterval(executeSync, syncIntervalMs);
      }
    };

    const stopSyncInterval = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    // Start sync if foregrounded on mount
    if (appState.current === 'active') {
      startSyncInterval();
    }

    // React Native AppState listener: pause in background to preserve battery, resume in foreground
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const isForegrounding = appState.current.match(/inactive|background/) && nextAppState === 'active';
      const isBackgrounding = nextAppState.match(/inactive|background/);

      appState.current = nextAppState;

      if (isForegrounding) {
        startSyncInterval();
      } else if (isBackgrounding) {
        stopSyncInterval();
      }
    });

    return () => {
      isMounted = false;
      stopSyncInterval();
      subscription.remove();
    };
  }, [user, profile, team?.teamId, syncIntervalMs]);
}