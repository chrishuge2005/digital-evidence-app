import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useOfflineSync } from '../hooks/useSync';
import { localDataCleanupService } from '../services/localDataCleanupService';

function RootNavigation() {
  const { isAuthenticated, loading, initialized, role } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Phase 20/23: Initialize background offline sync monitor
  useOfflineSync();

  useEffect(() => {
    let isMounted = true;

    // Register AppState listener to safely monitor app focus (preserves auth session & active work)
    const cleanupAppStateListener = localDataCleanupService.registerAppStateListener();

    async function enableKeepAwakeSafe() {
      try {
        await activateKeepAwakeAsync();
      } catch (error) {
        if (isMounted) {
          console.log('Keep awake notice:', error);
        }
      }
    }

    enableKeepAwakeSafe();

    return () => {
      isMounted = false;
      cleanupAppStateListener();
      deactivateKeepAwake().catch(() => {});
    };
  }, []);

  useEffect(() => {
    // CRITICAL: Do not navigate until the auth system has fully initialized.
    // "initialized" becomes true only after the INITIAL_SESSION event resolves
    // (session restored + profile/team loaded, or confirmed no session).
    // Without this guard, the router fires before auth is ready and causes
    // the infinite loading / redirect loop.
    if (!initialized || loading) {
      console.log('[ROUTER] Waiting for auth initialization...', { initialized, loading });
      return;
    }

    const inAuthGroup = segments[0] === '(auth)';
    const inOfficerGroup = segments[0] === '(officer)';
    const inHigherOfficerGroup = segments[0] === '(higher-officer)';
    const isPublicScreen = segments[0] === 'accept-invite';

    // Allow public screens like accept-invite to render regardless of authentication status
    if (isPublicScreen) {
      console.log('[ROUTER] On public screen:', segments[0]);
      return;
    }

    // Normalize role safely to uppercase to prevent casing mismatches
    const normalizedRole = role ? String(role).toUpperCase() : '';

    console.log('[ROUTER] Auth initialized. Deciding route.', {
      isAuthenticated,
      normalizedRole,
      currentSegment: segments[0],
    });

    if (!isAuthenticated && !inAuthGroup) {
      // Redirect unauthenticated users to login
      console.log('[ROUTER] No session — navigating to login.');
      router.replace('/(auth)/login');
    } else if (isAuthenticated) {
      if (inAuthGroup) {
        // Redirect to appropriate dashboard based on role once logged in from auth screen
        if (normalizedRole === 'HIGHER_OFFICER') {
          console.log('[ROUTER] Authenticated as HIGHER_OFFICER — navigating to dashboard.');
          router.replace('/(higher-officer)/dashboard');
        } else {
          console.log('[ROUTER] Authenticated as OFFICER — navigating to dashboard.');
          router.replace('/(officer)/dashboard');
        }
      } else {
        // Prevent cross-role group violations while navigating inside protected areas
        if (inOfficerGroup && normalizedRole === 'HIGHER_OFFICER') {
          router.replace('/(higher-officer)/dashboard');
        } else if (inHigherOfficerGroup && normalizedRole !== 'HIGHER_OFFICER') {
          router.replace('/(officer)/dashboard');
        }
      }
    }
  }, [isAuthenticated, loading, initialized, segments, role]);

  // Show loading spinner until auth initialization is complete.
  // This covers both the initial session restore AND subsequent profile loading.
  if (!initialized || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(officer)" />
      <Stack.Screen name="(higher-officer)" />
      <Stack.Screen name="accept-invite" options={{ presentation: 'card' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigation />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
});