import { supabase } from './supabase';
import { auditService } from './auditService';
import { custodyService } from './custodyService';

export const transferService = {
  /**
   * Search for an active officer by email on the specified team.
   */
  async findRecipientByEmail(teamId: string, email: string): Promise<any | null> {
    const cleanEmail = email.trim().toLowerCase();
    
    // 1. Get user by email
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_id, email, display_name, role')
      .ilike('email', cleanEmail)
      .maybeSingle();

    if (!profile) throw new Error('Officer not found.');

    // 2. Validate they are an active officer in the exact same team
    const { data: membership } = await supabase
      .from('team_members')
      .select('*')
      .eq('team_id', teamId)
      .eq('user_id', profile.user_id)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (!membership) {
      throw new Error('You can only transfer evidence to an active Officer in your own team.');
    }

    return profile;
  },

  /**
   * Create the PENDING transfer request and notify the recipient.
   */
  async createTransferRequest(evidenceId: string, teamId: string, receiverId: string): Promise<void> {
    if (!evidenceId || evidenceId === 'undefined' || evidenceId === 'null') {
      throw new Error("Cannot create transfer request: Evidence ID is missing.");
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');
    if (user.id === receiverId) throw new Error('You cannot transfer evidence to yourself.');

    // Insert Request
    const { data: requestData, error: requestError } = await supabase
      .from('transfer_requests')
      .insert({
        evidence_id: evidenceId,
        team_id: teamId,
        from_user_id: user.id,
        to_user_id: receiverId,
        status: 'PENDING'
      })
      .select('id')
      .single();

    if (requestError) {
      if (requestError.code === '23505') throw new Error('A transfer request is already pending for this evidence.');
      throw requestError;
    }

    // Generate Notification
    await supabase.from('notifications').insert({
      recipient_user_id: receiverId,
      type: 'TRANSFER_REQUEST',
      title: 'Evidence Transfer Request',
      message: `You have been requested to accept custody of evidence ${evidenceId}.`,
      evidence_id: evidenceId,
      transfer_request_id: requestData.id
    });

    // Custody Record (Transferred out)
    const actorName = user.user_metadata?.display_name || user.email || 'Officer';
    await custodyService.createCustodyEvent({
      evidenceId: evidenceId,
      teamId: teamId,
      action: 'EVIDENCE_TRANSFER_REQUESTED',
      performedByUserId: user.id,
      performedBy: actorName,
      role: 'OFFICER',
      status: 'SUCCESS',
      notes: `Transfer requested to officer ID: ${receiverId}`
    });

    // Phase 21: Log Immutable Audit Event
    await auditService.logAction({
      team_id: teamId,
      evidence_id: evidenceId,
      actor_user_id: user.id,
      actor_name: user.user_metadata?.display_name || user.email || 'Officer',
      actor_role: 'OFFICER',
      action: 'TRANSFER_REQUESTED',
      status: 'SUCCESS',
      description: `Transfer requested for evidence ${evidenceId}`,
      target_user_id: receiverId
    });
  },

  /**
   * Accept the pending transfer request, modifying the evidence owner via atomic RPC.
   */
  async acceptTransferRequest(requestId: string, evidenceId: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');

    // Call trusted database procedure accept_custody_transfer
    // This executes atomically: request status update, ownership transfer,
    // custody event logging, notification, and audit journal entry.
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('accept_custody_transfer', {
      p_request_id: requestId,
      p_evidence_id: evidenceId
    });

    if (rpcErr) throw rpcErr;
  },

  /**
   * Reject the pending transfer request via atomic RPC.
   */
  async rejectTransferRequest(requestId: string, evidenceId: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Authentication error');
    
    // Call trusted database procedure reject_custody_transfer
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('reject_custody_transfer', {
      p_request_id: requestId,
      p_reason: 'Transfer declined by recipient'
    });

    if (rpcErr) throw rpcErr;
  }
};
