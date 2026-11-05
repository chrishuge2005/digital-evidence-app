import { supabase } from './supabase';
import { custodyService } from './custodyService';
import { auditService } from './auditService';

export interface DeletionRequest {
  id: string;
  evidenceId: string;
  teamId: string;
  requestedByUserId: string;
  requestedByName: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approvedByUserId?: string;
  approvedByName?: string;
  requestedAt: string;
  respondedAt?: string;
  responseNotes?: string;
}

export const deletionService = {
  /**
   * Officer requests evidence deletion
   */
  async requestDeletion(evidenceId: string, teamId: string, reason: string): Promise<void> {
    if (!reason || reason.trim() === '') {
      throw new Error('A reason is required to request evidence deletion.');
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');

    // Get user profile name
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name, email, role')
      .eq('user_id', user.id)
      .single();

    const requesterName = profile?.display_name || profile?.email || 'Officer';

    // Check if a PENDING request already exists
    const { data: existing } = await supabase
      .from('deletion_requests')
      .select('id')
      .eq('evidence_id', evidenceId)
      .eq('status', 'PENDING')
      .maybeSingle();

    if (existing) {
      throw new Error('A deletion request is already pending for this evidence.');
    }

    // Insert deletion request
    const { data: reqData, error: reqError } = await supabase
      .from('deletion_requests')
      .insert({
        evidence_id: evidenceId,
        team_id: teamId,
        requested_by_user_id: user.id,
        requested_by_name: requesterName,
        reason: reason.trim(),
        status: 'PENDING'
      })
      .select('id')
      .single();

    if (reqError) throw reqError;

    // Create DELETION_REQUESTED custody event
    await custodyService.createCustodyEvent({
      evidenceId,
      teamId,
      action: 'DELETION_REQUESTED',
      performedByUserId: user.id,
      performedBy: requesterName,
      role: 'OFFICER',
      status: 'SUCCESS',
      notes: `Deletion requested. Reason: ${reason.trim()}`
    });

    // Phase 21: Log Immutable Audit Event
    await auditService.logAction({
      team_id: teamId,
      evidence_id: evidenceId,
      actor_user_id: user.id,
      actor_name: requesterName,
      actor_role: 'OFFICER',
      action: 'DELETION_REQUESTED',
      status: 'SUCCESS',
      description: `Deletion requested for evidence ${evidenceId}`
    });

    // Notify Higher Officer
    const { data: teamData } = await supabase
      .from('teams')
      .select('higher_officer_id, name')
      .eq('id', teamId)
      .single();

    if (teamData && teamData.higher_officer_id) {
      await supabase.from('notifications').insert({
        recipient_user_id: teamData.higher_officer_id,
        type: 'DELETION_REQUEST',
        title: 'Evidence Deletion Request',
        message: `${requesterName} requested deletion of evidence ${evidenceId}.`,
        evidence_id: evidenceId,
        is_read: false
      });
    }
  },

  /**
   * Get pending deletion requests for a Higher Officer's team
   */
  async getTeamDeletionRequests(teamId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('deletion_requests')
      .select('*')
      .eq('team_id', teamId)
      .order('requested_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  /**
   * Higher Officer approves deletion request (Atomic RPC-backed workflow)
   */
  async approveDeletion(requestId: string, evidenceId: string, teamId: string, responseNotes?: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');

    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name, email, role')
      .eq('user_id', user.id)
      .single();

    if (!profile || (profile.role !== 'higher_officer' && profile.role !== 'HIGHER_OFFICER')) {
      throw new Error('Unauthorized: Only Higher Officers can approve deletion requests.');
    }

    // 1. Call trusted RPC approve_evidence_deletion for atomic status transition,
    //    custody event logging, notification, and audit tracking.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('approve_evidence_deletion', {
      p_request_id: requestId,
      p_response_notes: responseNotes || 'Approved by Higher Officer'
    });

    if (rpcErr) throw rpcErr;

    // 2. Delete associated cloud storage files from private bucket (Higher Officer is authorized now that status is DELETED)
    const { data: evidenceRecord, error: evidenceFetchErr } = await supabase
      .from('evidence')
      .select('id')
      .eq('evidence_id', evidenceId)
      .maybeSingle();

    if (evidenceFetchErr) {
      console.error('Failed to retrieve evidence UUID for deletion:', evidenceFetchErr);
    }

    if (evidenceRecord) {
      const { data: attachments } = await supabase
        .from('evidence_attachments')
        .select('storage_file_id, attachment_id')
        .eq('evidence_id', evidenceRecord.id);

      if (attachments && attachments.length > 0) {
        const filePaths = attachments.map(att => att.storage_file_id).filter(Boolean);
        if (filePaths.length > 0) {
          const { error: deleteStorageErr } = await supabase.storage
            .from('evidence-files')
            .remove(filePaths);
          if (deleteStorageErr) {
            console.error('Failed to delete files from storage:', deleteStorageErr);
          }
        }
      }
    }
  },

  /**
   * Higher Officer rejects deletion request (Atomic RPC-backed workflow)
   */
  async rejectDeletion(requestId: string, evidenceId: string, teamId: string, responseNotes?: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');

    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name, email, role')
      .eq('user_id', user.id)
      .single();

    if (!profile || (profile.role !== 'higher_officer' && profile.role !== 'HIGHER_OFFICER')) {
      throw new Error('Unauthorized: Only Higher Officers can reject deletion requests.');
    }

    // Call trusted RPC reject_evidence_deletion for atomic status transition,
    // custody event logging, notification, and audit tracking.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('reject_evidence_deletion', {
      p_request_id: requestId,
      p_response_notes: responseNotes || 'Rejected by Higher Officer'
    });

    if (rpcErr) throw rpcErr;
  }
};
