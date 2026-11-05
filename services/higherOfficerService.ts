import { supabase } from './supabase';
import { analyticsService } from './analyticsService';
import { TeamAnalytics } from '../types/search';

export type TeamStatistics = TeamAnalytics;

export interface TeamOfficerSummary {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  joinedAt: string;
  evidenceCount: number;
  verifiedCount: number;
  pendingCount: number;
  failedCount: number;
}

export const higherOfficerService = {
  /**
   * Get team details and statistics securely for the authenticated Higher Officer
   */
  async getTeamDashboardData(): Promise<{ team: any; stats: TeamStatistics; officers: TeamOfficerSummary[] }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');

    // 1. Get team managed by this Higher Officer (Slim query)
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('id, name, team_code, higher_officer_id')
      .eq('higher_officer_id', user.id)
      .maybeSingle();

    if (teamError) throw teamError;
    let targetTeam = team;

    if (!targetTeam) {
      const { data: memberRecord } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .eq('status', 'ACTIVE')
        .maybeSingle();

      if (memberRecord?.team_id) {
        const { data: fallbackTeam } = await supabase
          .from('teams')
          .select('id, name, team_code, higher_officer_id')
          .eq('id', memberRecord.team_id)
          .maybeSingle();
        targetTeam = fallbackTeam;
      }
    }

    if (!targetTeam) {
      return {
        team: null,
        stats: {
          totalOfficers: 0,
          activeOfficers: 0,
          totalEvidence: 0,
          pendingVerify: 0,
          verified: 0,
          failedVerify: 0,
          pendingTransfers: 0,
          pendingDeletes: 0,
          recentActivityCount: 0,
        },
        officers: [],
      };
    }

    // 2. Get all team members
    const { data: members, error: memberError } = await supabase
      .from('team_members')
      .select('user_id, role, status, joined_at')
      .eq('team_id', targetTeam.id);

    if (memberError) throw memberError;

    const memberUserIds = (members || []).map(m => m.user_id);

    // 3. Get profiles for team members
    let profilesMap = new Map<string, any>();
    if (memberUserIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, email, display_name, role')
        .in('user_id', memberUserIds);

      profilesMap = new Map((profiles || []).map(p => [p.user_id, p]));
    }

    // 4. Get lightweight evidence data ONLY for officer breakdown stats
    // OPTIMIZATION 2: Removed select('*'). Only requesting the exact 2 columns needed for sorting counts.
    const { data: evidenceStats, error: evidenceError } = await supabase
      .from('evidence')
      .select('owner_id, verification_status') 
      .eq('team_id', targetTeam.id);

    if (evidenceError) throw evidenceError;

    // 5. Build per-officer stats map in memory
    const officerStatsMap = new Map<string, { total: number; verified: number; pending: number; failed: number }>();
    memberUserIds.forEach(id => {
      officerStatsMap.set(id, { total: 0, verified: 0, pending: 0, failed: 0 });
    });

    (evidenceStats || []).forEach(ev => {
      const status = ev.verification_status || 'PENDING';
      const ownerId = ev.owner_id;
      
      if (ownerId && officerStatsMap.has(ownerId)) {
        const stats = officerStatsMap.get(ownerId)!;
        stats.total++;
        if (status === 'VERIFIED') stats.verified++;
        else if (status === 'INTEGRITY_FAILED' || status === 'FAILED') stats.failed++;
        else stats.pending++;
      }
    });

    // 6. Map finalized officer summary list
    const officers: TeamOfficerSummary[] = (members || []).map(m => {
      const profile = profilesMap.get(m.user_id) || {};
      const stats = officerStatsMap.get(m.user_id) || { total: 0, verified: 0, pending: 0, failed: 0 };
      return {
        userId: m.user_id,
        email: profile.email || 'N/A',
        displayName: profile.display_name || profile.displayName || 'Officer',
        role: m.role || profile.role || 'OFFICER',
        status: m.status || 'ACTIVE',
        joinedAt: m.joined_at || new Date().toISOString(),
        evidenceCount: stats.total,
        verifiedCount: stats.verified,
        pendingCount: stats.pending,
        failedCount: stats.failed
      };
    });

    // OPTIMIZATION 1: Use external analyticsService for team-wide statistics rather than manually computing full rows.
    let stats: TeamStatistics;
    try {
      stats = await analyticsService.getHigherOfficerTeamStatistics(targetTeam.id);
    } catch (err) {
      console.warn("Analytics service failed, using fallback empty stats", err);
      // Fallback empty stats structure just in case
      stats = {
        totalOfficers: (members || []).length,
        activeOfficers: (members || []).filter(m => m.status === 'ACTIVE').length,
        totalEvidence: 0,
        pendingVerify: 0,
        verified: 0,
        failedVerify: 0,
        pendingTransfers: 0,
        pendingDeletes: 0,
        recentActivityCount: 0
      };
    }

    return { team: targetTeam, stats, officers };
  },

  /**
   * Get team evidence with optional search & filter
   * OPTIMIZATION 4 & 5 & 17 & 18: Client-side filtering replaced with DB filtering, pagination added, and attachments conditionally fetched.
   */
  async getTeamEvidence(
    teamId: string, 
    filters?: { 
      search?: string; 
      verificationStatus?: string; 
      ownerId?: string;
      includeAttachments?: boolean; // Default to false to save memory
      page?: number; 
      limit?: number; 
    }
  ): Promise<any[]> {
    
    // Select attachments ONLY if explicitly requested by the screen
    const selectQuery = filters?.includeAttachments ? '*, evidence_attachments(*)' : '*';

    let query = supabase
      .from('evidence')
      .select(selectQuery)
      .eq('team_id', teamId);

    // Filter at the database level instead of downloading everything and filtering in JS
    if (filters) {
      if (filters.verificationStatus && filters.verificationStatus !== 'ALL') {
        query = query.eq('verification_status', filters.verificationStatus);
      }
      
      if (filters.ownerId && filters.ownerId !== 'ALL') {
        query = query.eq('owner_id', filters.ownerId);
      }

      if (filters.search && filters.search.trim() !== '') {
        const term = `%${filters.search.trim()}%`;
        // Utilize PostgREST's 'or' query syntax to search across multiple columns securely
        query = query.or(`evidence_id.ilike.${term},title.ilike.${term},description.ilike.${term}`);
      }

      if (filters.page && filters.limit) {
        const offset = (filters.page - 1) * filters.limit;
        query = query.range(offset, offset + filters.limit - 1);
      }
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    
    if (error) throw error;
    return data || [];
  },

  /**
   * Get recent team custody activity
   */
  async getTeamActivity(teamId: string, limit = 20): Promise<any[]> {
    const { data, error } = await supabase
      .from('evidence_custody')
      .select('*') // Depending on component usage, slim this down to explicit columns if needed
      .eq('team_id', teamId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  },

  /**
   * Get transfer activity for team
   */
  async getTeamTransfers(teamId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('transfer_requests')
      .select('*')
      .eq('team_id', teamId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }
};