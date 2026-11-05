import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import { supabase } from './supabase';
import { Evidence, EvidenceAttachment } from '../types/evidence';
import { localEvidenceService } from './localEvidenceService';
import { syncService } from './syncService';
import { EvidenceSearchParams } from '../types/search';

const toISOStringSafe = (dateInput: any): string => {
  if (!dateInput) return new Date().toISOString();
  try {
    const date = new Date(dateInput);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch (e) {}
  return new Date().toISOString();
};

const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
};

export const evidenceService = {
  
  async createEvidenceOfflineFirst(evidenceData: any, attachments: any[], user: any, teamId: string) {
    if (!user || !teamId) throw new Error("Missing auth context for offline creation.");

    const evidencePayload = {
      evidence_id: evidenceData.evidenceId || generateUUID(),
      team_id: teamId,
      owner_id: user.id,
      created_by: user.id, // Explicitly set original creator field
      title: evidenceData.title,
      description: evidenceData.description || null,
      category: evidenceData.category || 'General',
      location: evidenceData.location || null,
      status: 'ACTIVE',
      verification_status: 'PENDING',
      captured_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      _syncStatus: 'PENDING'
    };

    const localRaw = await AsyncStorage.getItem('@local_evidence_cache');
    const localEvidence = localRaw ? JSON.parse(localRaw) : [];
    localEvidence.push(evidencePayload);
    await AsyncStorage.setItem('@local_evidence_cache', JSON.stringify(localEvidence));

    await syncService.enqueue('CREATE_EVIDENCE', evidencePayload.evidence_id, {
      ...evidencePayload,
      _syncStatus: undefined 
    });

    for (const att of attachments) {
      const attachmentId = att.id || att.attachmentId || generateUUID();
      const attachmentPayload = {
        attachment_id: attachmentId,
        evidence_id: evidencePayload.evidence_id,
        original_name: att.fileName || att.originalName || 'file',
        mime_type: att.mimeType || 'application/octet-stream',
        file_size: att.fileSize || 0,
        sha256: att.sha256,
        localUri: att.uri || att.localUri, 
        storageFileId: `${teamId}/${evidencePayload.evidence_id}/${attachmentId}`
      };
      await syncService.enqueue('UPLOAD_ATTACHMENT', attachmentId, attachmentPayload);
    }

    const custodyId = generateUUID();
    const custodyPayload = {
      custody_id: custodyId,
      evidence_id: evidencePayload.evidence_id,
      team_id: teamId,
      action: 'EVIDENCE_REGISTERED',
      performed_by_user_id: user.id,
      performed_by: user.user_metadata?.display_name || user.email || 'Officer',
      role: 'OFFICER',
      status: 'SUCCESS',
      notes: 'Evidence captured offline-first',
      timestamp: new Date().toISOString()
    };
    await syncService.enqueue('CREATE_CUSTODY', custodyId, custodyPayload);

    syncService.processQueue().catch(() => {});

    return evidencePayload;
  },

  async syncEvidenceToCloud(evidence: Evidence, attachments: EvidenceAttachment[]): Promise<boolean> {
    try {
      const { error: evidenceError } = await supabase.from('evidence').upsert({
        evidence_id: evidence.evidenceId,
        team_id: evidence.teamId,
        owner_id: evidence.ownerId,
        created_by: (evidence as any).created_by || evidence.ownerId, // Ensure created_by is preserved on sync upsert
        assigned_officer_id: evidence.assignedOfficerId,
        title: evidence.title,
        description: evidence.description,
        category: evidence.category,
        location: evidence.location,
        captured_at: toISOStringSafe(evidence.capturedAt),
        status: evidence.status,
        verification_status: ['PENDING', 'VERIFIED', 'REJECTED', 'INTEGRITY_FAILED', 'UNAVAILABLE', 'PARTIALLY_VERIFIED'].includes(evidence.verificationStatus as string)
          ? evidence.verificationStatus
          : 'PENDING',
        cloud_verification_status: evidence.cloudVerificationStatus || 'NOT_VERIFIED',
        created_at: toISOStringSafe(evidence.createdAt),
        updated_at: toISOStringSafe(evidence.updatedAt),
      }, { onConflict: 'evidence_id' });

      if (evidenceError) {
        if (evidenceError.message.includes('401') || evidenceError.message.includes('403')) {
          throw new Error('AUTH_REQUIRED');
        }
        console.error("Cloud evidence sync error:", evidenceError);
        return false;
      }

      const { data: cloudEvidence, error: fetchError } = await supabase
        .from('evidence')
        .select('id')
        .eq('evidence_id', evidence.evidenceId)
        .maybeSingle();

      if (fetchError || !cloudEvidence) {
        console.error("Failed to retrieve cloud evidence ID:", fetchError);
        return false;
      }

      for (const att of attachments) {
        const { error: attError } = await supabase.from('evidence_attachments').upsert({
          attachment_id: att.attachmentId,
          evidence_id: cloudEvidence.id,
          original_name: att.originalName,
          mime_type: att.mimeType,
          file_size: att.fileSize,
          local_uri: att.localUri,
          storage_file_id: att.storageFileId || att.storagePath || null, 
          sha256: att.sha256, 
          upload_status: att.uploadStatus,
          cloud_verification_status: att.cloudVerificationStatus || 'NOT_VERIFIED',
          cloud_last_verified_hash: att.cloudLastVerifiedHash || null,
          cloud_last_verified_at: att.cloudLastVerifiedAt ? toISOStringSafe(att.cloudLastVerifiedAt) : null,
          created_at: toISOStringSafe(att.createdAt),
          updated_at: toISOStringSafe(att.updatedAt),
        }, { onConflict: 'attachment_id' });

        if (attError) {
          if (attError.message.includes('401') || attError.message.includes('403')) throw new Error('AUTH_REQUIRED');
          console.error(`Cloud attachment sync error for ${att.originalName}:`, attError);
          return false;
        }
      }

      return true;
    } catch (error: any) {
      if (error.message === 'AUTH_REQUIRED') throw error; 
      console.error("Exception during cloud evidence synchronization:", error);
      return false;
    }
  },

  async getEvidenceDetails(evidenceId: string): Promise<{ evidence: any; attachments: any[] } | null> {
    try {
      const { data: evidence, error: evError } = await supabase
        .from('evidence')
        .select('*')
        .eq('evidence_id', evidenceId)
        .maybeSingle();

      if (evError) throw evError;
      if (!evidence) return null;

      const { data: attachments, error: attError } = await supabase
        .from('evidence_attachments')
        .select('*')
        .eq('evidence_id', evidence.id);

      if (attError) throw attError;

      return { evidence, attachments: attachments || [] };
    } catch (error: any) {
      console.error('Error fetching evidence details:', error.message);
      return null;
    }
  },

  async updateVerificationStatus(evidenceId: string, status: 'VERIFIED' | 'REJECTED'): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('evidence')
        .update({ verification_status: status, updated_at: new Date().toISOString() })
        .eq('evidence_id', evidenceId);

      if (error) {
        console.warn("Cloud update failed (possibly offline). Attempting local update...", error.message);
      }

      try {
        await localEvidenceService.updateEvidenceVerificationStatus(evidenceId, status);
      } catch (localErr) {
        console.warn("Could not update local storage cache for evidence status:", localErr);
      }

      return true;
    } catch (error: any) {
      console.error('Error updating verification status:', error.message);
      throw error;
    }
  },

  async getUnifiedLocalEvidence(): Promise<any[]> {
    let listA: any[] = [];
    try {
      listA = await localEvidenceService.getLocalEvidence();
    } catch {}

    let listB: any[] = [];
    try {
      const rawB = await AsyncStorage.getItem('@local_evidence_cache');
      if (rawB) listB = JSON.parse(rawB);
    } catch {}

    const map = new Map<string, any>();
    (Array.isArray(listB) ? listB : []).forEach(item => {
      const key = item.evidence_id || item.evidenceId || item.id;
      if (key) map.set(key, item);
    });
    (Array.isArray(listA) ? listA : []).forEach(item => {
      const key = item.evidence_id || item.evidenceId || item.id;
      if (key) map.set(key, item);
    });

    return Array.from(map.values());
  },

  filterLocalEvidence(localList: any[], params: EvidenceSearchParams): any[] {
    let result = [...localList];

    if (params.teamId) {
      result = result.filter((e: any) => e.team_id === params.teamId || e.teamId === params.teamId);
    }

    const isOwnerMatch = (e: any) =>
      e.created_by === params.ownerId ||
      e.createdBy === params.ownerId ||
      e.owner_id === params.ownerId ||
      e.ownerId === params.ownerId;

    if (params.scope === 'YOURS' && params.ownerId) {
      result = result.filter(isOwnerMatch);
    } else if (params.scope === 'TRANSFERS' && params.ownerId) {
      result = result.filter((e: any) =>
        (e.owner_id === params.ownerId || e.ownerId === params.ownerId) &&
        e.created_by !== params.ownerId && e.createdBy !== params.ownerId
      );
    } else if (params.scope === 'ALL' && params.ownerId) {
      result = result.filter(isOwnerMatch);
    } else if (params.ownerId && !params.scope) {
      result = result.filter(isOwnerMatch);
    }

    if (params.status && params.status !== 'ALL') {
      result = result.filter((e: any) => e.status === params.status);
    }

    if (params.verificationStatus && params.verificationStatus !== 'ALL') {
      result = result.filter((e: any) =>
        (e.verification_status || e.verificationStatus) === params.verificationStatus
      );
    }

    if (params.query) {
      const q = params.query.toLowerCase().trim();
      result = result.filter((e: any) =>
        (e.evidence_id || e.evidenceId)?.toLowerCase().includes(q) ||
        (e.title)?.toLowerCase().includes(q) ||
        (e.description)?.toLowerCase().includes(q) ||
        (e.officer_name)?.toLowerCase().includes(q) ||
        (e.badge_number)?.toLowerCase().includes(q)
      );
    }

    result.sort((a: any, b: any) => {
      const dateA = new Date(a.created_at || a.createdAt || a.captured_at || a.capturedAt || 0).getTime();
      const dateB = new Date(b.created_at || b.createdAt || b.captured_at || b.capturedAt || 0).getTime();
      return dateB - dateA;
    });

    return result;
  },

  async searchEvidence(params: EvidenceSearchParams): Promise<{ data: any[]; count: number; error?: string; isOffline?: boolean }> {
    try {
      let isConnected = true;
      let isInternetReachable = true;
      try {
        const network = await Network.getNetworkStateAsync();
        isConnected = !!network.isConnected;
        isInternetReachable = network.isInternetReachable !== false;
      } catch {}

      if (!isConnected || !isInternetReachable) {
        const localAll = await this.getUnifiedLocalEvidence();
        const filtered = this.filterLocalEvidence(localAll, params);
        const count = filtered.length;
        const start = (params.page - 1) * params.limit;
        return { data: filtered.slice(start, start + params.limit), count, isOffline: true };
      }

      try {
        let query = supabase.from('evidence').select('*', { count: 'exact' });

        // Business Rule Scope Implementations
        if (params.scope === 'YOURS' && params.ownerId) {
          query = query.or(`created_by.eq.${params.ownerId},and(created_by.is.null,owner_id.eq.${params.ownerId})`);
        } else if (params.scope === 'TRANSFERS' && params.ownerId) {
          const { data: transferData, error: transferErr } = await supabase
            .from('transfer_requests')
            .select('evidence_id')
            .eq('to_user_id', params.ownerId)
            .eq('status', 'ACCEPTED');

          if (transferErr) {
            console.error('Error fetching transfer requests for search:', transferErr.message);
          }

          const transferredEvidenceIds = (transferData || []).map((t: any) => t.evidence_id).filter(Boolean);
          if (transferredEvidenceIds.length > 0) {
            query = query.in('evidence_id', transferredEvidenceIds);
          } else {
            const localAll = await this.getUnifiedLocalEvidence();
            const localTransfers = this.filterLocalEvidence(localAll, params);
            return { data: localTransfers, count: localTransfers.length, isOffline: false };
          }
        } else if (params.scope === 'ALL' && params.ownerId) {
          const { data: transferData } = await supabase
            .from('transfer_requests')
            .select('evidence_id')
            .eq('to_user_id', params.ownerId)
            .eq('status', 'ACCEPTED');

          const transferredEvidenceIds = (transferData || []).map((t: any) => t.evidence_id).filter(Boolean);
          const ownerCondition = `created_by.eq.${params.ownerId},and(created_by.is.null,owner_id.eq.${params.ownerId})`;
          if (transferredEvidenceIds.length > 0) {
            query = query.or(`${ownerCondition},evidence_id.in.(${transferredEvidenceIds.join(',')})`);
          } else {
            query = query.or(ownerCondition);
          }
        } else if (params.teamId) {
          query = query.eq('team_id', params.teamId);
        } else if (params.ownerId) {
          query = query.eq('owner_id', params.ownerId);
        }

        if (params.status && params.status !== 'ALL') query = query.eq('status', params.status);
        if (params.verificationStatus && params.verificationStatus !== 'ALL') query = query.eq('verification_status', params.verificationStatus);
        
        if (params.query) {
          const q = params.query.trim();
          let matchingOfficerIds: string[] = [];
          try {
            const { data: matchedProfiles } = await supabase
              .from('profiles')
              .select('user_id')
              .or(`display_name.ilike.%${q}%,badge_number.ilike.%${q}%`);
            if (matchedProfiles && matchedProfiles.length > 0) {
              matchingOfficerIds = matchedProfiles.map((p: any) => p.user_id).filter(Boolean);
            }
          } catch {}

          if (matchingOfficerIds.length > 0) {
            const idList = matchingOfficerIds.join(',');
            query = query.or(`evidence_id.ilike.%${q}%,title.ilike.%${q}%,description.ilike.%${q}%,owner_id.in.(${idList}),created_by.in.(${idList})`);
          } else {
            query = query.or(`evidence_id.ilike.%${q}%,title.ilike.%${q}%,description.ilike.%${q}%`);
          }
        }

        const start = (params.page - 1) * params.limit;
        query = query.order('created_at', { ascending: false }).range(start, start + params.limit - 1);

        const { data, count, error } = await query;
        if (error) throw error;

        // Fetch local evidence to merge any unsynced / locally registered items
        const localAll = await this.getUnifiedLocalEvidence();
        const localFiltered = this.filterLocalEvidence(localAll, params);

        const cloudMap = new Map<string, any>();
        (data || []).forEach((item: any) => {
          const key = item.evidence_id || item.evidenceId;
          if (key) cloudMap.set(key, item);
        });

        const pendingOrLocalOnly: any[] = [];
        for (const localItem of localFiltered) {
          const key = localItem.evidence_id || localItem.evidenceId;
          if (!cloudMap.has(key)) {
            pendingOrLocalOnly.push({
              ...localItem,
              syncStatus: localItem.syncStatus || 'PENDING',
              _syncStatus: 'PENDING'
            });
          }
        }

        const combined = [...pendingOrLocalOnly, ...(data || [])];
        const uniqueData = Array.from(
          new Map(combined.map((item: any) => [item.evidence_id || item.evidenceId || item.id, item])).values()
        );

        // Fetch officer names/badges for Higher Officer / team cards if user IDs are present
        const ownerUserIds = Array.from(new Set(uniqueData.map(d => d.created_by || d.owner_id || d.ownerId).filter(Boolean)));
        if (ownerUserIds.length > 0) {
          try {
            const { data: profiles } = await supabase
              .from('profiles')
              .select('user_id, display_name, badge_number')
              .in('user_id', ownerUserIds);

            if (profiles && profiles.length > 0) {
              const profileMap = new Map(profiles.map(p => [p.user_id, p]));
              uniqueData.forEach(item => {
                const uid = item.created_by || item.owner_id || item.ownerId;
                if (uid && profileMap.has(uid)) {
                  const prof = profileMap.get(uid);
                  if (prof) {
                    item.officer_name = prof.display_name;
                    item.badge_number = prof.badge_number;
                  }
                }
              });
            }
          } catch {}
        }

        const totalCount = (count || (data || []).length) + pendingOrLocalOnly.length;
        return { data: uniqueData, count: totalCount, isOffline: false };

      } catch (cloudErr: any) {
        console.warn('Cloud search failed, falling back to local evidence:', cloudErr?.message || cloudErr);
        const localAll = await this.getUnifiedLocalEvidence();
        const filtered = this.filterLocalEvidence(localAll, params);
        const count = filtered.length;
        const start = (params.page - 1) * params.limit;
        return { data: filtered.slice(start, start + params.limit), count, isOffline: true };
      }
    } catch (err: any) {
      console.error('Evidence search error:', err.message);
      return { data: [], count: 0, error: err.message };
    }
  }
};
