import { supabase } from './supabase';
import { syncService } from './syncService';
import { AuditCreateInput, AuditLog } from '../types/audit';

const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
};

export const auditService = {
  /**
   * Logs an action to the local sync queue for offline-first resilience.
   * Ensures no audit logs are dropped due to network issues.
   */
  async logAction(input: AuditCreateInput): Promise<void> {
    try {
      const auditId = generateUUID();
      const payload: AuditLog = {
        id: auditId,
        ...input,
        created_at: new Date().toISOString()
      };

      // Hand off to Phase 20 persistent sync queue
      await syncService.enqueue('CREATE_AUDIT_LOG', auditId, payload);
    } catch (error) {
      console.error('Failed to enqueue audit log:', error);
    }
  },

  /**
   * Retrieves paginated team audit logs.
   * Protected inherently by Supabase RLS.
   */
  async getTeamAuditLogs(teamId: string, limit: number = 50): Promise<AuditLog[]> {
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data as AuditLog[]) || [];
    } catch (error: any) {
      console.error('Error fetching team audit logs:', error.message);
      return [];
    }
  },

  /**
   * Retrieves audit logs for a specific piece of evidence.
   */
  async getEvidenceAuditLogs(evidenceId: string): Promise<AuditLog[]> {
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('evidence_id', evidenceId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data as AuditLog[]) || [];
    } catch (error: any) {
      console.error('Error fetching evidence audit logs:', error.message);
      return [];
    }
  }
};