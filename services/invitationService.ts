import { supabase } from './supabase';
import { sha256 } from 'js-sha256';

export interface SendOfficerInvitationParams {
  teamId: string;
  email: string;
  displayName: string;
}

export interface InvitationDetails {
  valid: boolean;
  reason?: string;
  email?: string;
  displayName?: string;
  teamName?: string;
  teamCode?: string;
  invitedByName?: string;
  expiresAt?: string;
}

export interface PendingOfficerInvitation {
  id: string;
  team_id: string;
  team_name: string;
  team_code: string;
  display_name: string;
  email: string;
  invited_by_name: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expires_at: string;
  created_at: string;
}

export interface OfficerInvitationRecord {
  id: string;
  team_id: string;
  email: string;
  display_name: string;
  invited_by: string;
  token_hash: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expires_at: string;
  accepted_by?: string | null;
  accepted_at?: string | null;
  created_at: string;
}

export const invitationService = {
  /**
   * Hashes a raw token with SHA-256 for database lookup or storage.
   */
  hashToken(token: string): string {
    return sha256(token.trim());
  },

  /**
   * Higher Officer sends an invitation to an officer with only Name & Email.
   * Invokes the secure Edge Function 'send-officer-invite'.
   */
  async sendOfficerInvitation(params: SendOfficerInvitationParams): Promise<{ success: boolean; message: string }> {
    const { teamId, email, displayName } = params;

    if (!teamId) throw new Error('Department team is required.');
    if (!email || !email.trim()) throw new Error('Officer email is required.');
    if (!displayName || !displayName.trim()) throw new Error('Officer name is required.');

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = displayName.trim();

    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new Error(`Invalid email address format: "${cleanEmail}".`);
    }

    if (cleanName.length > 100) {
      throw new Error('Officer name must be 100 characters or less.');
    }

    try {
      const { data, error } = await supabase.functions.invoke('send-officer-invite', {
        body: {
          teamId,
          email: cleanEmail,
          displayName: cleanName,
        },
      });

      if (error) {
        let detail = error.message;
        const statusCode = (error as any)?.context?.status;
        if ('context' in error && error.context && typeof (error.context as any).json === 'function') {
          try {
            const body = await (error.context as any).json();
            if (body?.error) detail = body.error;
          } catch {}
        }

        if (statusCode === 404 || detail.includes('non-2xx status code')) {
          throw new Error(
            'The invitation service (Edge Function "send-officer-invite") is not yet deployed to this Supabase project. ' +
            'Please deploy the Edge Function using the Supabase CLI or Dashboard.'
          );
        }

        throw new Error(detail || 'Failed to dispatch officer invitation email.');
      }

      if (!data?.success) {
        throw new Error(data?.error || 'Failed to send officer invitation.');
      }

      return {
        success: true,
        message: data.message || `Official invitation email sent to ${cleanEmail}.`,
      };
    } catch (err: any) {
      console.error('Error invoking send-officer-invite:', err);
      throw err;
    }
  },

  /**
   * Safely retrieves public invitation details for the invite acceptance landing screen.
   * Does NOT require user authentication.
   */
  async getInvitationDetails(rawToken: string): Promise<InvitationDetails> {
    if (!rawToken || !rawToken.trim()) {
      return { valid: false, reason: 'Invitation token is missing.' };
    }

    try {
      const tokenHash = this.hashToken(rawToken);
      const { data, error } = await supabase.rpc('get_invitation_details', {
        p_token_hash: tokenHash,
      });

      if (error) {
        return { valid: false, reason: error.message };
      }

      return {
        valid: data?.valid ?? false,
        reason: data?.reason,
        email: data?.email,
        displayName: data?.display_name,
        teamName: data?.team_name,
        teamCode: data?.team_code,
        invitedByName: data?.invited_by_name,
        expiresAt: data?.expires_at,
      };
    } catch (err: any) {
      return { valid: false, reason: err.message || 'Failed to fetch invitation details.' };
    }
  },

  /**
   * Accepts an invitation using the authenticated officer's verified session.
   * Invokes the atomic database RPC 'accept_officer_invitation'.
   */
  async acceptInvitation(rawToken: string): Promise<{ success: boolean; message: string; teamId: string }> {
    if (!rawToken || !rawToken.trim()) {
      throw new Error('Invitation token is required.');
    }

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      throw new Error('You must be signed in with your official account to accept this invitation.');
    }

    const tokenHash = this.hashToken(rawToken);

    const { data, error } = await supabase.rpc('accept_officer_invitation', {
      p_token_hash: tokenHash,
    });

    if (error) {
      console.error('accept_officer_invitation RPC error:', error);
      throw new Error(error.message || 'Failed to accept invitation.');
    }

    return {
      success: true,
      message: data?.message || 'Invitation accepted successfully.',
      teamId: data?.team_id,
    };
  },

  /**
   * Accepts an invitation by its invitation ID directly from in-app notifications.
   * Invokes the atomic database RPC 'accept_officer_invitation_by_id'.
   */
  async acceptInvitationById(invitationId: string): Promise<{ success: boolean; message: string; teamId: string }> {
    if (!invitationId || !invitationId.trim()) {
      throw new Error('Invitation ID is required.');
    }

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      throw new Error('You must be signed in with your official account to accept this invitation.');
    }

    const { data, error } = await supabase.rpc('accept_officer_invitation_by_id', {
      p_invitation_id: invitationId,
    });

    if (error) {
      console.error('accept_officer_invitation_by_id RPC error:', error);
      throw new Error(error.message || 'Failed to accept invitation.');
    }

    return {
      success: true,
      message: data?.message || 'Invitation accepted successfully.',
      teamId: data?.team_id,
    };
  },

  /**
   * Discovers any active pending invitations for the authenticated officer's verified email.
   * Invokes the secure database RPC 'get_my_pending_invitations'.
   */
  async getMyPendingInvitations(): Promise<PendingOfficerInvitation[]> {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) return [];

      const { data, error } = await supabase.rpc('get_my_pending_invitations');

      if (error) {
        console.warn('Error fetching pending invitations:', error.message);
        return [];
      }

      return (data as PendingOfficerInvitation[]) || [];
    } catch (err: any) {
      console.warn('Exception in getMyPendingInvitations:', err.message);
      return [];
    }
  },

  /**
   * Higher Officer retrieves all invitations for their team.
   */
  async getTeamInvitations(teamId: string): Promise<OfficerInvitationRecord[]> {
    try {
      const { data, error } = await supabase
        .from('officer_invitations')
        .select('*')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false });

      if (error) {
        // If table has not yet been migrated in this Supabase database, log informative warning
        if (error.code === 'PGRST205' || error.message?.includes('schema cache') || error.message?.includes('relation "public.officer_invitations" does not exist')) {
          console.warn(
            '[MIGRATION REQUIRED] Table "public.officer_invitations" does not exist in the remote Supabase project. ' +
            'Please execute "supabase/migrations/20261102_officer_invitations.sql" in the Supabase SQL Editor.'
          );
          return [];
        }
        throw error;
      }
      return (data as OfficerInvitationRecord[]) || [];
    } catch (err: any) {
      console.warn('Error fetching team invitations:', err.message);
      return [];
    }
  },

  /**
   * Higher Officer revokes a pending invitation.
   */
  async revokeInvitation(invitationId: string): Promise<void> {
    const { error } = await supabase
      .from('officer_invitations')
      .update({ status: 'REVOKED', updated_at: new Date().toISOString() })
      .eq('id', invitationId)
      .eq('status', 'PENDING');

    if (error) {
      throw new Error(error.message || 'Failed to revoke invitation.');
    }
  },
};
