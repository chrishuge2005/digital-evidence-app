import { supabase } from './supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TEAM_CACHE_KEY = '@cached_officer_team';

export interface CreateTeamMemberParams {
  teamId: string;
  email: string;
  displayName: string;
  badgeNumber?: string;
  password?: string;
}

export interface TeamMemberWithProfile {
  user_id: string;
  role: string;
  status: string;
  joined_at: string;
  profiles: {
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    badge_number?: string | null;
  } | null;
}

export const teamService = {
  async getOfficerTeam(): Promise<any | null> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      // 1. Check if the user is an active member of a team as an officer
      const { data: membership, error: memberError } = await supabase
        .from('team_members')
        .select('team_id, teams(id, team_code, name, higher_officer_id)')
        .eq('user_id', user.id)
        .eq('status', 'ACTIVE')
        .maybeSingle();

      if (memberError) {
        console.error("Error fetching officer team membership:", memberError.message);
      }

      let teamData: any = null;
      if (membership && membership.teams) {
        teamData = Array.isArray(membership.teams) ? membership.teams[0] : membership.teams;
      } else {
        // 2. Fallback: Check if the user is a Higher Officer owning a team
        const { data: ownedTeam, error: teamError } = await supabase
          .from('teams')
          .select('id, team_code, name, higher_officer_id')
          .eq('higher_officer_id', user.id)
          .maybeSingle();

        if (teamError) {
          console.error("Error fetching higher officer team:", teamError.message);
          // If offline/error occurs, try loading from cache before giving up
          throw teamError;
        }
        teamData = ownedTeam;
      }

      if (!teamData) {
        // If no online team found, check cache as fallback
        const cachedData = await AsyncStorage.getItem(TEAM_CACHE_KEY);
        if (cachedData) return JSON.parse(cachedData);
        return null;
      }

      // 3. Fetch the Higher Officer's profile details using higher_officer_id
      let higherOfficerProfile = null;
      if (teamData.higher_officer_id) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('user_id, display_name, email, role')
          .eq('user_id', teamData.higher_officer_id)
          .maybeSingle();
        
        higherOfficerProfile = profileData;
      }

      const finalTeamInfo = {
        ...teamData,
        higher_officer: higherOfficerProfile
      };

      // 4. Save successfully retrieved online team data to local cache
      await AsyncStorage.setItem(TEAM_CACHE_KEY, JSON.stringify(finalTeamInfo));

      return finalTeamInfo;
    } catch (error) {
      console.warn("Network error or offline. Attempting to load cached team info...", error);
      
      // Offline Fallback: Retrieve from local AsyncStorage cache
      try {
        const cachedData = await AsyncStorage.getItem(TEAM_CACHE_KEY);
        if (cachedData) {
          return JSON.parse(cachedData);
        }
      } catch (cacheError) {
        console.error("Failed to load local team cache:", cacheError);
      }

      return null;
    }
  },

  async getMyTeamHO(): Promise<{ id: string; team_code: string; name: string } | null> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data: teamData, error } = await supabase
        .from('teams')
        .select('id, team_code, name')
        .eq('higher_officer_id', user.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching Higher Officer team:", error.message);
        return null;
      }

      return teamData || null;
    } catch (error) {
      console.error("Unexpected error in getMyTeamHO:", error);
      return null;
    }
  },

  async createTeam(name: string, teamCode: string): Promise<{ id: string; name: string; team_code: string } | null> {
    try {
      if (!name || !teamCode) {
        throw new Error("Team name and department team code are required.");
      }

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        throw new Error("Authentication session expired or missing.");
      }

      // TEMPORARY DIAGNOSTIC (remove after RLS investigation)
      const {
        data: sessionData,
        error: sessionError,
      } = await supabase.auth.getSession();

      console.log('[TEAM INSERT SESSION CHECK]', {
        sessionUserId: sessionData.session?.user.id ?? null,
        expectedUserId: user.id,
        hasAccessToken: Boolean(sessionData.session?.access_token),
        sessionError: sessionError?.message ?? null,
      });

      const cleanName = String(name).trim();
      const cleanCode = String(teamCode).trim().toUpperCase();

      // TEMPORARY DIAGNOSTIC (remove after RLS investigation)
      console.log('[CREATE TEAM DEBUG]', {
        authUserId: user.id,
        email: user.email,
        teamName: cleanName,
        teamCode: cleanCode,
      });

      const { data, error } = await supabase
        .from('teams')
        .insert({
          name: cleanName,
          team_code: cleanCode,
          higher_officer_id: user.id
        })
        .select('id, name, team_code, higher_officer_id')
        .single();

      if (error) {
        // TEMPORARY DIAGNOSTIC (remove after RLS investigation)
        console.error('[CREATE TEAM SUPABASE ERROR]', {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        });

        if (error.code === '23505') {
          throw new Error(`A department team with code "${cleanCode}" already exists.`);
        }
        throw new Error(error.message || "Failed to create department team record.");
      }

      // Link Higher Officer's profile to the new team
      try {
        await supabase
          .from('profiles')
          .update({ team_id: data.id })
          .eq('user_id', user.id);
      } catch (profileLinkErr) {
        console.warn("Could not set team_id on Higher Officer profile:", profileLinkErr);
      }

      return data;
    } catch (error: any) {
      console.error("Error in createTeam service:", error.message);
      throw error;
    }
  },

  /**
   * Unified team member creation / assignment:
   * 1. Attempts to invoke Edge Function 'create-team-member' (which can provision user auth or invite).
   * 2. If Edge Function is unavailable or fails due to network, falls back to RPC 'add_officer_to_team'.
   */
  async createOrAddTeamMember(params: CreateTeamMemberParams): Promise<{ success: boolean; message: string }> {
    const { teamId, email, displayName, badgeNumber, password } = params;

    if (!teamId) throw new Error("Team ID is required.");
    if (!email || !email.trim()) throw new Error("Email address is required.");
    if (!displayName || !displayName.trim()) throw new Error("Full name is required.");

    const cleanEmail = email.trim().toLowerCase();
    const cleanDisplayName = displayName.trim();
    const cleanBadgeNumber = badgeNumber?.trim() || null;

    // First attempt: invoke Edge Function 'create-team-member'
    try {
      const { data: edgeData, error: edgeError } = await supabase.functions.invoke('create-team-member', {
        body: {
          teamId,
          email: cleanEmail,
          displayName: cleanDisplayName,
          badgeNumber: cleanBadgeNumber,
          password: password || undefined,
        },
      });

      if (!edgeError && edgeData?.success) {
        return {
          success: true,
          message: edgeData.message || `Officer ${cleanDisplayName} successfully added to team.`,
        };
      }

      // If edge function returned an error response
      if (edgeError) {
        let detailError = edgeError.message;
        if ('context' in edgeError && edgeError.context && typeof (edgeError.context as any).json === 'function') {
          try {
            const errBody = await (edgeError.context as any).json();
            if (errBody?.error) detailError = errBody.error;
          } catch {}
        }

        const isNetworkFailure =
          detailError.includes('FunctionsFetchError') ||
          detailError.includes('Failed to send a request') ||
          detailError.includes('Network request failed');

        if (!isNetworkFailure) {
          throw new Error(detailError);
        }
      }
    } catch (edgeCallErr: any) {
      const isNetworkFailure =
        edgeCallErr.message?.includes('FunctionsFetchError') ||
        edgeCallErr.message?.includes('Failed to send a request') ||
        edgeCallErr.message?.includes('Network request failed');

      if (!isNetworkFailure) {
        throw edgeCallErr;
      }
      console.warn("Edge Function unavailable (network/un-deployed), falling back to database RPC:", edgeCallErr.message);
    }

    // Fallback: Use database RPC add_officer_to_team
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('add_officer_to_team', {
        p_team_id: teamId,
        p_email: cleanEmail,
        p_badge_number: cleanBadgeNumber,
      });

      if (rpcError) {
        throw new Error(rpcError.message);
      }

      return {
        success: true,
        message: rpcData?.message || `Officer ${cleanDisplayName} successfully added to team.`,
      };
    } catch (rpcErr: any) {
      console.error("RPC add_officer_to_team failed:", rpcErr.message);
      throw new Error(
        rpcErr.message ||
        `Unable to add officer "${cleanEmail}". Ensure the officer has registered an account or that the Edge Function is deployed.`
      );
    }
  },

  async addTeamMemberByEmail(teamId: string, email: string): Promise<boolean> {
    try {
      if (!teamId || !email) {
        throw new Error("Team ID and email address are required.");
      }

      const cleanEmail = String(email).trim().toLowerCase();

      // Use the trusted RPC add_officer_to_team to bypass RLS restrictions safely
      const { data: rpcData, error: rpcError } = await supabase.rpc('add_officer_to_team', {
        p_team_id: teamId,
        p_email: cleanEmail,
        p_badge_number: null,
      });

      if (rpcError) {
        throw new Error(rpcError.message);
      }

      return true;
    } catch (error: any) {
      console.error('Error adding team member by email:', error.message);
      throw error;
    }
  },

  async getTeamMembers(teamId: string): Promise<TeamMemberWithProfile[]> {
    try {
      // 1. Get team member rows
      const { data: members, error: memberError } = await supabase
        .from('team_members')
        .select('user_id, role, status, joined_at')
        .eq('team_id', teamId);

      if (memberError) throw memberError;
      if (!members || members.length === 0) return [];

      // 2. Extract user IDs and fetch their profiles manually
      const userIds = members.map(m => m.user_id);
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, email, display_name, role, badge_number')
        .in('user_id', userIds);

      if (profileError) {
        console.warn('Profile fetch warning in getTeamMembers:', profileError.message);
      }

      // 3. Combine members with their profile data
      const profileMap = new Map((profiles || []).map(p => [p.user_id, p]));
      const combined: TeamMemberWithProfile[] = members.map(m => ({
        ...m,
        profiles: profileMap.get(m.user_id) || null,
      }));

      return combined;
    } catch (error: any) {
      console.error('Error fetching team members:', error.message);
      return [];
    }
  },

  /**
   * Deactivate an officer from a team using the trusted RPC.
   * Preserves digital custody audit history and prevents data corruption.
   */
  async deactivateOfficer(teamId: string, userId: string, reason = 'Deactivated by Higher Officer'): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('deactivate_team_officer', {
        p_team_id: teamId,
        p_officer_user_id: userId,
        p_reason: reason,
      });

      if (error) throw new Error(error.message);
    } catch (error: any) {
      console.error('Error deactivating officer:', error.message);
      throw error;
    }
  },

  /**
   * Backward-compatible alias for removing/deactivating an officer
   */
  async removeOfficerFromTeam(teamId: string, userId: string): Promise<void> {
    return this.deactivateOfficer(teamId, userId);
  }
};