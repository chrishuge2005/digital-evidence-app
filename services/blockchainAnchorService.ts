import { supabase } from './supabase';

/**
 * Blockchain Anchor Service (Mobile Client Interface)
 *
 * SECURITY & ARCHITECTURE:
 * Production blockchain transaction signing and private keys remain strictly
 * on the backend / Edge Functions / Hardhat test node.
 * The mobile client reads blockchain anchor status and triggers anchor queue requests.
 */

export interface BlockchainAnchorRecord {
  id: string;
  evidence_id: string;
  team_id: string;
  anchor_type: 'EVIDENCE' | 'CUSTODY';
  reference_id: string;
  data_hash: string;
  blockchain_network: string;
  chain_id: string;
  contract_address: string;
  transaction_hash?: string | null;
  block_number?: number | null;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  error_message?: string | null;
  created_at: string;
  confirmed_at?: string | null;
}

export const blockchainAnchorService = {
  /**
   * Fetch confirmed blockchain anchor record for an evidence item.
   */
  async getEvidenceAnchor(evidenceId: string): Promise<BlockchainAnchorRecord | null> {
    try {
      const { data, error } = await supabase
        .from('blockchain_anchors')
        .select('*')
        .eq('evidence_id', evidenceId)
        .eq('anchor_type', 'EVIDENCE')
        .maybeSingle();

      if (error) {
        console.warn('Error fetching evidence anchor:', error.message);
        return null;
      }
      return data as BlockchainAnchorRecord | null;
    } catch (err) {
      console.warn('Blockchain anchor fetch exception:', err);
      return null;
    }
  },

  /**
   * Fetch all blockchain anchor records for a team.
   */
  async getTeamAnchors(teamId: string): Promise<BlockchainAnchorRecord[]> {
    try {
      const { data, error } = await supabase
        .from('blockchain_anchors')
        .select('*')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Error fetching team anchors:', error.message);
        return [];
      }
      return (data || []) as BlockchainAnchorRecord[];
    } catch (err) {
      console.warn('Team anchors fetch exception:', err);
      return [];
    }
  },

  /**
   * Request evidence anchoring (records PENDING anchor for backend worker processing).
   */
  async requestEvidenceAnchor(evidenceId: string, teamId: string, originalSha256: string): Promise<void> {
    try {
      const { data: existing } = await supabase
        .from('blockchain_anchors')
        .select('id, status')
        .eq('evidence_id', evidenceId)
        .eq('anchor_type', 'EVIDENCE')
        .maybeSingle();

      if (existing && existing.status === 'CONFIRMED') {
        return;
      }

      const payload = {
        evidence_id: evidenceId,
        team_id: teamId,
        anchor_type: 'EVIDENCE',
        reference_id: evidenceId,
        data_hash: originalSha256,
        blockchain_network: 'polygon_amoy',
        chain_id: '80002',
        contract_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        status: 'PENDING',
      };

      if (existing) {
        await supabase
          .from('blockchain_anchors')
          .update(payload)
          .eq('id', existing.id);
      } else {
        await supabase
          .from('blockchain_anchors')
          .insert(payload);
      }
    } catch (err: any) {
      console.warn('Failed to queue blockchain anchor request:', err?.message || err);
    }
  }
};