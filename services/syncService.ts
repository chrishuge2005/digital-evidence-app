import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { localEvidenceService } from './localEvidenceService';
import { storageService } from './storageService';
import { custodyService } from './custodyService';
import { CustodyEvent, EvidenceAttachment, Evidence } from '../types/evidence';
import { SyncTask, SyncOperationType } from '../types/sync';

const SYNC_QUEUE_KEY = '@sync_queue';
const MAX_RETRIES = 5;

// Prevents race conditions from multiple simultaneous background syncs
let syncInProgress = false;

// Safe ISO timestamp helper
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

export const syncService = {
  // ========================================================================
  // 1. OFFLINE SYNC QUEUE SYSTEM
  // ========================================================================

  async getQueue(): Promise<SyncTask[]> {
    try {
      const q = await AsyncStorage.getItem(SYNC_QUEUE_KEY);
      return q ? JSON.parse(q) : [];
    } catch {
      return [];
    }
  },

  async saveQueue(queue: SyncTask[]) {
    await AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  },

  async enqueue(type: SyncOperationType, entityId: string, payload: any) {
    const queue = await this.getQueue();
    const existing = queue.find(
      (t) => t.type === type && t.entityId === entityId && (t.status === 'PENDING' || t.status === 'FAILED')
    );
    if (existing) return;

    const newTask: SyncTask = {
      syncId: `${Date.now()}_${Math.random().toString(36).substring(7)}`,
      type,
      entityId,
      payload,
      status: 'PENDING',
      retryCount: 0,
      createdAt: Date.now(),
    };

    queue.push(newTask);
    await this.saveQueue(queue);
    
    this.processQueue().catch(console.error);
  },

  async processQueue() {
    if (syncInProgress) return;
    
    const network = await Network.getNetworkStateAsync();
    if (!network.isConnected) return; // Removed isInternetReachable to avoid emulator bugs

    syncInProgress = true;

    try {
      const queue = await this.getQueue();
      const pendingTasks = queue.filter((t) => t.status === 'PENDING' || (t.status === 'FAILED' && t.retryCount < MAX_RETRIES));
      
      const typePriority: Record<SyncOperationType, number> = {
        'CREATE_EVIDENCE': 1,
        'UPLOAD_ATTACHMENT': 2,
        'CREATE_CUSTODY': 3,
        'CREATE_AUDIT_LOG': 4
      };
      
      pendingTasks.sort((a, b) => {
        if (typePriority[a.type] !== typePriority[b.type]) {
          return typePriority[a.type] - typePriority[b.type];
        }
        return a.createdAt - b.createdAt;
      });

      for (const task of pendingTasks) {
        try {
          task.lastAttemptAt = Date.now();
          
          if (task.type === 'CREATE_EVIDENCE') {
            await this.handleCreateEvidence(task.payload);
          } else if (task.type === 'UPLOAD_ATTACHMENT') {
            await this.handleUploadAttachment(task.payload);
          } else if (task.type === 'CREATE_CUSTODY') {
            await this.handleCreateCustody(task.payload);
          } else if (task.type === 'CREATE_AUDIT_LOG') {
            await this.handleCreateAuditLog(task.payload);
          }

          task.status = 'SYNCED';
          task.lastError = undefined;
        } catch (error: any) {
          const errMsg = error.message || 'Unknown error';
          task.lastError = errMsg;
          
          if (errMsg === 'AUTH_REQUIRED' || errMsg.includes('401') || errMsg.includes('403')) {
            task.status = 'FAILED';
            break; 
          }
          
          if (errMsg === 'LOCAL_FILE_UNAVAILABLE') {
            task.status = 'FAILED';
            task.retryCount = MAX_RETRIES;
          } else if (errMsg.includes('Duplicate') || errMsg.includes('already exists') || errMsg.includes('23505')) {
             task.status = 'SYNCED';
             task.lastError = undefined;
          } else {
             task.retryCount += 1;
             task.status = task.retryCount >= MAX_RETRIES ? 'FAILED' : 'PENDING';
          }
        }
      }

      await this.saveQueue(queue.filter((t) => t.status !== 'SYNCED'));
    } finally {
      syncInProgress = false;
    }
  },

  async handleCreateEvidence(payload: any) {
    const { error } = await supabase
      .from('evidence')
      .upsert(payload, { onConflict: 'evidence_id', ignoreDuplicates: true });
    if (error) throw error;
  },

  async handleUploadAttachment(payload: any) {
    const { localUri, storageFileId, ...dbPayload } = payload;
    
    const { data: existing } = await supabase
      .from('evidence_attachments')
      .select('attachment_id')
      .eq('attachment_id', dbPayload.attachment_id || dbPayload.attachmentId)
      .maybeSingle();

    if (!existing) {
      try {
        const fileInfo = await FileSystem.getInfoAsync(localUri);
        if (!fileInfo.exists) throw new Error('LOCAL_FILE_UNAVAILABLE');

        const response = await fetch(localUri);
        const blob = await response.blob();
        
        const { error: uploadError } = await supabase.storage
          .from('evidence-files') // Fixed bucket name
          .upload(storageFileId, blob, { upsert: false });
          
        if (uploadError && !uploadError.message.includes('Duplicate') && !uploadError.message.includes('already exists')) {
          throw uploadError;
        }
      } catch (err: any) {
        if (err.message === 'LOCAL_FILE_UNAVAILABLE') throw err;
        if (!err.message?.includes('Duplicate') && !err.message?.includes('already exists')) throw err;
      }

      const { error: dbError } = await supabase
        .from('evidence_attachments')
        .upsert({ ...dbPayload, storage_file_id: storageFileId }, { onConflict: 'attachment_id', ignoreDuplicates: true });
      if (dbError) throw dbError;
    }
  },

  async handleCreateCustody(payload: any) {
    const { error } = await supabase
      .from('evidence_custody')
      .upsert(payload, { onConflict: 'custody_id', ignoreDuplicates: true });
    if (error) throw error;
  },

  async handleCreateAuditLog(payload: any) {
    const { error } = await supabase
      .from('audit_logs')
      .upsert(payload, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
  },

  // ========================================================================
  // 2. DIRECT / UI SYNC METHODS
  // ========================================================================

  async processAllPending(): Promise<void> {
    if (syncInProgress) return;
    const network = await Network.getNetworkStateAsync();
    if (!network.isConnected) return; // Removed isInternetReachable to avoid emulator bugs

    try {
      await this.processQueue();
      await this.syncPendingEvidence();
      await this.syncPendingCustodyEvents();
    } catch (e) {
      console.warn("processAllPending issue:", e);
    }
  },

  async syncEvidenceItem(evidenceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const localData = await localEvidenceService.getLocalEvidenceById(evidenceId);
      if (!localData || !localData.evidence) {
        return { success: false, error: 'Local evidence record not found.' };
      }

      const { evidence, attachments } = localData;

      // Ensure metadata exists in cloud before attachments are uploaded
      const initialMetaSync = await this.directSyncToCloud(evidence, []);
      if (!initialMetaSync) {
        return { success: false, error: 'Initial evidence metadata synchronization failed.' };
      }

      const updatedAttachments: EvidenceAttachment[] = [...attachments];
      
      for (let i = 0; i < updatedAttachments.length; i++) {
        const att = updatedAttachments[i];
        
        if (att.uploadStatus !== 'UPLOADED') {
          if (att.localUri) {
            const fileInfo = await FileSystem.getInfoAsync(att.localUri);
            if (!fileInfo.exists) {
              const errMsg = 'LOCAL_FILE_UNAVAILABLE';
              await this.safeUpdateAttachmentStatus(att.attachmentId, 'FAILED', undefined);
              await localEvidenceService.updateSyncStatus(evidenceId, 'FAILED', undefined, errMsg);
              return { success: false, error: errMsg };
            }
          }

          // THIS CALLS storageService.ts - ensure bucket name is fixed there too!
          const uploadResult = await storageService.uploadAttachmentFile(
            evidence.teamId, 
            evidence.evidenceId, 
            att
          );

          if (uploadResult.success && uploadResult.storagePath) {
            att.storageFileId = uploadResult.storagePath;
            att.uploadStatus = 'UPLOADED';
            await this.safeUpdateAttachmentStatus(att.attachmentId, 'UPLOADED', uploadResult.storagePath);
          } else {
            const errReason = uploadResult.error || 'Storage upload failed.';
            if (errReason.includes('401') || errReason.includes('403') || errReason.includes('AUTH_REQUIRED')) {
              await localEvidenceService.updateSyncStatus(evidenceId, 'PENDING', undefined, 'Auth failed. Waiting for token refresh.');
              throw new Error('AUTH_REQUIRED');
            }
            await this.safeUpdateAttachmentStatus(att.attachmentId, 'FAILED', undefined);
            await localEvidenceService.updateSyncStatus(evidenceId, 'FAILED', undefined, errReason);
            return { success: false, error: `Attachment upload failed: ${errReason}` };
          }
        }
      }

      // Execute direct sync to cloud
      const syncSuccess = await this.directSyncToCloud(evidence, updatedAttachments);

      if (syncSuccess) {
        const timestamp = new Date().toISOString();
        await localEvidenceService.updateSyncStatus(evidenceId, 'SYNCED', timestamp);
        return { success: true };
      } else {
        const errorMsg = 'Cloud synchronization rejected by database.';
        await localEvidenceService.updateSyncStatus(evidenceId, 'FAILED', undefined, errorMsg);
        return { success: false, error: errorMsg };
      }
    } catch (error: any) {
      const errorMsg = error?.message || 'Network unavailable or synchronization error.';
      if (errorMsg !== 'AUTH_REQUIRED') {
        await localEvidenceService.updateSyncStatus(evidenceId, 'FAILED', undefined, errorMsg);
      }
      return { success: false, error: errorMsg };
    }
  },

  async directSyncToCloud(evidence: Evidence, attachments: EvidenceAttachment[]): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const ownerId = evidence.ownerId || (evidence as any).owner_id || user?.id;
      const assignedOfficerId = evidence.assignedOfficerId || (evidence as any).assigned_officer_id || ownerId;

      if (!ownerId) {
        console.error("Sync error: No authenticated user or owner_id found.");
        return false;
      }

      // Permitted verification statuses per database CHECK constraint
      const VALID_VERIFICATION_STATUSES = [
        'PENDING',
        'VERIFIED',
        'REJECTED',
        'INTEGRITY_FAILED',
        'UNAVAILABLE',
        'PARTIALLY_VERIFIED',
      ];

      // Normalize verification_status for database insertion:
      // - Preserves all 6 valid database verification statuses
      // - Maps legacy 'NOT_VERIFIED' (which belongs to cloud_verification_status) to 'PENDING'
      // - Fallback to 'PENDING' for missing/invalid status
      const rawStatus = (evidence.verificationStatus as string) || '';
      const normalizedVerificationStatus = VALID_VERIFICATION_STATUSES.includes(rawStatus)
        ? rawStatus
        : 'PENDING';

      // Base payload data
      const basePayload = {
        title: evidence.title,
        description: evidence.description,
        category: evidence.category,
        location: evidence.location,
        captured_at: toISOStringSafe(evidence.capturedAt),
        status: evidence.status,
        verification_status: normalizedVerificationStatus,
        cloud_verification_status: evidence.cloudVerificationStatus || 'NOT_VERIFIED',
        updated_at: toISOStringSafe(evidence.updatedAt),
      };

      // Check if record already exists in Supabase
      const { data: existingRecord } = await supabase
        .from('evidence')
        .select('id, evidence_id')
        .eq('evidence_id', evidence.evidenceId)
        .maybeSingle();

      if (existingRecord) {
        // Update existing row WITHOUT touching owner_id to avoid the ownership security trigger violation
        const { error: updateError } = await supabase
          .from('evidence')
          .update(basePayload)
          .eq('evidence_id', evidence.evidenceId);

        if (updateError) {
          console.error("SUPABASE UPDATE ERROR FAILED:", JSON.stringify(updateError));
          return false;
        }
      } else {
        // Insert new row WITH owner_id to satisfy the NOT-NULL constraint
        const insertPayload = {
          ...basePayload,
          evidence_id: evidence.evidenceId,
          team_id: evidence.teamId,
          owner_id: ownerId,
          created_by: (evidence as any).created_by || ownerId,
          assigned_officer_id: assignedOfficerId,
          created_at: toISOStringSafe(evidence.createdAt),
        };

        const { error: insertError } = await supabase.from('evidence').insert([insertPayload]);
        if (insertError) {
          console.error("SUPABASE INSERT ERROR FAILED:", JSON.stringify(insertError));
          return false;
        }
      }

      // Get cloud reference ID for attachments
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

  async safeUpdateAttachmentStatus(attachmentId: string, status: string, storageFileId?: string) {
    if (typeof (localEvidenceService as any).updateAttachmentStatus === 'function') {
      await (localEvidenceService as any).updateAttachmentStatus(attachmentId, status, storageFileId);
    } else {
      await localEvidenceService.updateAttachmentMetadata(attachmentId, {
        uploadStatus: status as any,
        ...(storageFileId && { storageFileId })
      });
    }
  },

  async syncPendingEvidence(): Promise<void> {
    try {
      const allEvidence = await localEvidenceService.getLocalEvidence();
      const pendingItems = allEvidence.filter(
        ev => ev.syncStatus === 'PENDING' || ev.syncStatus === 'FAILED' || ev.syncStatus === 'LOCAL_ONLY'
      );

      for (const item of pendingItems) {
        const res = await this.syncEvidenceItem(item.evidenceId);
        if (res.error === 'AUTH_REQUIRED') break;
      }
    } catch (error) {
      console.warn('Background evidence sync check skipped or failed:', error);
    }
  },

  async syncCustodyEvent(custodyId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const stored = await AsyncStorage.getItem('@local_custody_events');
      if (!stored) return { success: false, error: 'No local custody history found.' };
      
      const history: CustodyEvent[] = JSON.parse(stored);
      const event = history.find(e => e.custodyId === custodyId);
      
      if (!event) return { success: false, error: 'Custody event not found locally.' };

      await custodyService.updateSyncStatus(custodyId, 'PENDING');

      const { data: cloudEvidence, error: fetchError } = await supabase
        .from('evidence')
        .select('id')
        .eq('evidence_id', event.evidenceId)
        .maybeSingle();

      if (fetchError || !cloudEvidence) {
        const errMsg = 'Parent evidence not synced yet. Sync evidence first.';
        await custodyService.updateSyncStatus(custodyId, 'PENDING', undefined, errMsg);
        return { success: false, error: errMsg };
      }

      const { error: supabaseError } = await supabase.from('evidence_custody').upsert({
        custody_id: event.custodyId,
        evidence_id: cloudEvidence.id,
        team_id: event.teamId,
        action: event.action,
        performed_by_user_id: event.performedByUserId,
        performed_by: event.performedBy,
        role: event.role,
        timestamp: event.timestamp,
        status: event.status,
        notes: event.notes || null,
        recipient_user_id: event.recipientUserId || null,
        recipient_name: event.recipientName || null,
        recipient_role: event.recipientRole || null,
      }, { onConflict: 'custody_id' });

      if (supabaseError) {
        const errMsg = supabaseError.message || 'Cloud custody sync failed.';
        if (errMsg.includes('401') || errMsg.includes('403')) throw new Error('AUTH_REQUIRED');
        
        await custodyService.updateSyncStatus(custodyId, 'FAILED', undefined, errMsg);
        return { success: false, error: errMsg };
      }

      await custodyService.updateSyncStatus(custodyId, 'SYNCED', new Date().toISOString());
      return { success: true };
    } catch (error: any) {
      const errMsg = error?.message || 'Network unavailable for custody sync.';
      if (errMsg !== 'AUTH_REQUIRED') {
        await custodyService.updateSyncStatus(custodyId, 'FAILED', undefined, errMsg);
      }
      return { success: false, error: errMsg };
    }
  },

  async syncPendingCustodyEvents(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem('@local_custody_events');
      if (!stored) return;
      
      const history: CustodyEvent[] = JSON.parse(stored);
      const pendingItems = history.filter(
        ev => ev.syncStatus === 'PENDING' || ev.syncStatus === 'FAILED' || ev.syncStatus === 'LOCAL_ONLY'
      );

      for (const item of pendingItems) {
        if (item.custodyId) {
          const res = await this.syncCustodyEvent(item.custodyId);
          if (res.error === 'AUTH_REQUIRED') break;
        }
      }
    } catch (error) {
      console.warn('Background custody sync check skipped or failed:', error);
    }
  },

  async pullLatestData(teamId: string): Promise<void> {
    if (!teamId) return;
    const network = await Network.getNetworkStateAsync();
    if (!network.isConnected) return; // Removed isInternetReachable to avoid emulator bugs

    try {
      const { data: cloudEvidence, error } = await supabase
        .from('evidence')
        .select('*')
        .eq('team_id', teamId);
        
      if (error) throw error;
      
      const localRaw = await AsyncStorage.getItem('@local_evidence_cache');
      let localEvidence = localRaw ? JSON.parse(localRaw) : [];
      
      localEvidence = localEvidence.map((localE: any) => {
        const cId = localE.evidence_id || localE.evidenceId;
        const cloudE = cloudEvidence.find((c: any) => (c.evidence_id || c.evidenceId) === cId);
        
        if (!cloudE && localE.syncStatus === 'SYNCED') {
          return { ...localE, status: 'DELETED' };
        }

        if (cloudE) {
          if (localE.ownerId !== cloudE.owner_id) {
            localE.ownerId = cloudE.owner_id;
            localE.owner_id = cloudE.owner_id;
            localE._conflict = 'OWNER_RESOLVED';
          }
          if (localE.status !== cloudE.status) {
            localE.status = cloudE.status;
          }
          if (localE.sha256 && cloudE.sha256 && localE.sha256 !== cloudE.sha256) {
            localE._conflict = 'SHA256_MISMATCH_DETECTED'; 
          }
          
          return { ...localE, ...cloudE, syncStatus: 'SYNCED' };
        }
        
        return localE; 
      });

      for (const cloudE of cloudEvidence) {
        const cId = cloudE.evidence_id || cloudE.evidenceId;
        if (!localEvidence.find((l: any) => (l.evidence_id || l.evidenceId) === cId)) {
          localEvidence.push({ ...cloudE, syncStatus: 'SYNCED' });
        }
      }

      await AsyncStorage.setItem('@local_evidence_cache', JSON.stringify(localEvidence));
    } catch (err) {
      console.warn("Conflict resolution pull failed:", err);
    }
  }
};