import { supabase } from './supabase';
import { TeamAnalytics, OfficerAnalytics } from '../types/search';

export const analyticsService = {
  
  async getHigherOfficerTeamStatistics(teamId: string): Promise<TeamAnalytics> {
    const fetchCount = async (table: string, filters: Record<string, any>) => {
      let q = supabase.from(table).select('*', { count: 'exact', head: true }).eq('team_id', teamId);
      for (const [key, val] of Object.entries(filters)) q = q.eq(key, val);
      const { count } = await q;
      return count || 0;
    };

    const [
      totalEvidence, verified, pendingVerify, failedVerify,
      pendingTransfers, acceptedTransfers,
      pendingDeletes, approvedDeletes,
      activeOfficers
    ] = await Promise.all([
      fetchCount('evidence', { status: 'ACTIVE' }),
      fetchCount('evidence', { verification_status: 'VERIFIED', status: 'ACTIVE' }),
      fetchCount('evidence', { verification_status: 'PENDING', status: 'ACTIVE' }),
      fetchCount('evidence', { verification_status: 'INTEGRITY_FAILED', status: 'ACTIVE' }),
      fetchCount('transfer_requests', { status: 'PENDING' }),
      fetchCount('transfer_requests', { status: 'ACCEPTED' }),
      fetchCount('deletion_requests', { status: 'PENDING' }),
      fetchCount('deletion_requests', { status: 'APPROVED' }),
      fetchCount('team_members', { status: 'ACTIVE' })
    ]);

    return {
      totalEvidence, verified, pendingVerify, failedVerify,
      pendingTransfers, acceptedTransfers,
      pendingDeletes, approvedDeletes, activeOfficers
    };
  },

  async getOfficerStatistics(userId: string, teamId: string): Promise<OfficerAnalytics> {
    const fetchCount = async (table: string, filters: Record<string, any>) => {
      let q = supabase.from(table).select('*', { count: 'exact', head: true }).eq('team_id', teamId);
      for (const [key, val] of Object.entries(filters)) q = q.eq(key, val);
      const { count } = await q;
      return count || 0;
    };

    const [totalEvidence, verified, pendingTransfers, pendingDeletes] = await Promise.all([
      fetchCount('evidence', { owner_id: userId, status: 'ACTIVE' }),
      fetchCount('evidence', { owner_id: userId, verification_status: 'VERIFIED', status: 'ACTIVE' }),
      fetchCount('transfer_requests', { from_user_id: userId, status: 'PENDING' }),
      fetchCount('deletion_requests', { requested_by_user_id: userId, status: 'PENDING' })
    ]);

    return { totalEvidence, verified, pendingTransfers, pendingDeletes };
  }
};