import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { cacheDirectory, getInfoAsync, readDirectoryAsync, deleteAsync } from 'expo-file-system/legacy';
import { supabase } from '../services/supabase';
import { localDataCleanupService } from '../services/localDataCleanupService';
import { Profile as UserProfile, UserRole } from '../types/auth';

export interface TeamMembership {
  teamId: string;
  userId: string;
  role: string;
  status: 'ACTIVE' | 'INACTIVE';
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  team: TeamMembership | null;
  role: UserRole | null;
  loading: boolean;
  initialized: boolean;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [team, setTeam] = useState<TeamMembership | null>(null);
  const [loading, setLoading] = useState(true);

  // initialized = true once the very first session check has fully completed.
  // The router must wait for this before navigating.
  const [initialized, setInitialized] = useState(false);

  // Prevent the double-initialization race: if onAuthStateChange fires while
  // getSession() is still running, we skip the duplicate fetchUserData call.
  const initializingRef = useRef(false);

  const fetchUserData = async (currentUser: User): Promise<void> => {
    console.log('[AUTH] Loading profile for user:', currentUser.id);
    try {
      // 1. Fetch profile
      let { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', currentUser.id)
        .maybeSingle();

      if (profileError) {
        console.error('[PROFILE ERROR] Failed to fetch profile:', profileError.message);
      }

      // If profile not found immediately, retry after 500ms (database trigger propagation delay)
      if (!profileData && !profileError) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const { data: retryProfile, error: retryError } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', currentUser.id)
          .maybeSingle();

        if (retryProfile) {
          profileData = retryProfile;
        } else if (retryError) {
          console.error('[PROFILE ERROR] Retry fetch profile failed:', retryError.message);
        }
      }

      // If profile still missing, create fallback OFFICER profile strictly with user's verified identity.
      // Never allow client self-promotion to HIGHER_OFFICER.
      if (!profileData) {
        console.warn('[AUTH] Profile row missing for user. Creating fallback OFFICER profile for:', currentUser.id);
        const { data: createdProfile, error: insertError } = await supabase
          .from('profiles')
          .insert({
            user_id: currentUser.id,
            email: currentUser.email || '',
            display_name: currentUser.user_metadata?.display_name || 'Officer',
            role: 'OFFICER',
          })
          .select()
          .maybeSingle();

        if (insertError) {
          console.error('[PROFILE ERROR] Failed to create fallback profile:', insertError.message);
        } else if (createdProfile) {
          profileData = createdProfile;
        }
      } else if (!profileData.display_name && currentUser.user_metadata?.display_name) {
        // Sync display_name from metadata if profile had empty display_name
        try {
          await supabase
            .from('profiles')
            .update({ display_name: currentUser.user_metadata.display_name })
            .eq('user_id', currentUser.id);
          profileData.display_name = currentUser.user_metadata.display_name;
        } catch (updateErr) {
          console.warn('[AUTH] Failed to sync display_name to profile:', updateErr);
        }
      }

      if (profileData) {
        console.log('[AUTH] Profile loaded. Role:', profileData.role);
        setProfile(profileData);
      } else {
        console.warn('[AUTH] No profile found for user:', currentUser.id);
        setProfile(null);
      }

      // 2. Fetch active team membership
      console.log('[AUTH] Loading team membership...');
      const { data: teamData, error: teamError } = await supabase
        .from('team_members')
        .select('team_id, user_id, role, status')
        .eq('user_id', currentUser.id)
        .eq('status', 'ACTIVE')
        .maybeSingle();

      if (teamError) {
        console.warn('[TEAM ERROR] Team membership fetch warning:', teamError.message);
        setTeam(null);
      } else if (teamData) {
        console.log('[AUTH] Team loaded:', teamData.team_id);
        setTeam({
          teamId: teamData.team_id,
          userId: teamData.user_id,
          role: teamData.role,
          status: teamData.status,
        });
      } else {
        console.log('[AUTH] No active team membership in team_members. Checking managed teams for Higher Officer...');
        const { data: ownedTeam } = await supabase
          .from('teams')
          .select('id')
          .eq('higher_officer_id', currentUser.id)
          .maybeSingle();

        if (ownedTeam) {
          console.log('[AUTH] Higher Officer managed team found:', ownedTeam.id);
          setTeam({
            teamId: ownedTeam.id,
            userId: currentUser.id,
            role: 'HIGHER_OFFICER',
            status: 'ACTIVE',
          });
        } else {
          console.log('[AUTH] No active team or managed team found.');
          setTeam(null);
        }
      }
    } catch (err: any) {
      // An unexpected exception during profile/team loading must NOT
      // leave the app on a permanent loading screen.
      console.error('[AUTH ERROR] Unexpected error during user data fetch:', err?.message ?? err);
      setProfile(null);
      setTeam(null);
    } finally {
      // This ALWAYS runs — success, error, or exception.
      // loading and initialized will always be resolved.
      console.log('[AUTH] Authentication initialization complete.');
      setLoading(false);
      setInitialized(true);
    }
  };

  useEffect(() => {
    console.log('[AUTH] App initialization started.');

    // Use onAuthStateChange as the SINGLE source of truth for initialization.
    // Supabase v2 emits INITIAL_SESSION immediately on subscription with the
    // persisted session (or null). This replaces the separate getSession() call
    // and eliminates the race condition between the two.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      console.log('[AUTH] Auth state change event:', event);

      if (event === 'INITIAL_SESSION') {
        initializingRef.current = true;

        setSession(newSession);
        setUser(newSession?.user ?? null);

        if (newSession?.user) {
          console.log('[AUTH] Session restored. Loading user data...');
          await fetchUserData(newSession.user);
        } else {
          console.log('[AUTH] No persisted session found. Redirecting to login.');
          setProfile(null);
          setTeam(null);
          setLoading(false);
          setInitialized(true);
        }

        initializingRef.current = false;
        return;
      }

      // Handle subsequent auth events (login, logout, token refresh).
      if (event === 'SIGNED_IN') {
        console.log('[AUTH] User signed in.');
        setSession(newSession);
        setUser(newSession?.user ?? null);

        if (newSession?.user) {
          setLoading(true);
          await fetchUserData(newSession.user);
        }
        return;
      }

      if (event === 'SIGNED_OUT') {
        console.log('[AUTH] User signed out. Clearing state.');
        setSession(null);
        setUser(null);
        setProfile(null);
        setTeam(null);
        setLoading(false);
        // Keep initialized=true so the router navigates to login immediately.
        return;
      }

      if (event === 'TOKEN_REFRESHED') {
        console.log('[AUTH] Token refreshed successfully.');
        setSession(newSession);
        setUser(newSession?.user ?? null);
        // No need to reload profile on token refresh.
        return;
      }

      if (event === 'USER_UPDATED') {
        console.log('[AUTH] User updated. Reloading profile...');
        setSession(newSession);
        setUser(newSession?.user ?? null);
        if (newSession?.user) {
          setLoading(true);
          await fetchUserData(newSession.user);
        }
        return;
      }
    });

    return () => {
      console.log('[AUTH] Cleaning up auth subscription.');
      subscription.unsubscribe();
    };
  }, []);

  const refreshProfile = async () => {
    if (user) {
      console.log('[AUTH] Refreshing profile...');
      setLoading(true);
      await fetchUserData(user);
    }
  };

  const signOut = async () => {
    console.log('[AUTH] Signing out...');
    try {
      // 1. Complete local data wipe (evidence files, sync queue, custody logs, caches, AsyncStorage keys)
      await localDataCleanupService.clearAllLocalApplicationData();
    } catch (error) {
      console.warn('[AUTH] Error during local data cleanup on logout:', error);
    }

    try {
      // 2. Sign out of Supabase
      await supabase.auth.signOut();
    } catch (error: any) {
      console.warn('[AUTH] Supabase signOut error (non-fatal):', error?.message);
    }

    // 3. Clear local React state
    setSession(null);
    setUser(null);
    setProfile(null);
    setTeam(null);
  };

  // Normalize role to uppercase
  const role: UserRole | null = profile?.role
    ? (String(profile.role).toUpperCase() as UserRole)
    : null;

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        profile,
        team,
        role,
        loading,
        initialized,
        isAuthenticated: !!session && !!user,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}