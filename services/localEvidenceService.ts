import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Evidence, EvidenceAttachment, VerificationStatus } from '../types/evidence';

const EVIDENCE_KEY = '@local_evidence_metadata';
const ATTACHMENTS_KEY = '@local_evidence_attachments';

export const localEvidenceService = {
  generateEvidenceId(): string {
    const year = new Date().getFullYear();
    const randomNum = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    return `EV-${year}-${randomNum}`;
  },

  generateAttachmentId(): string {
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `ATT-${randomNum}`;
  },

  async ensureDirectoryExists(evidenceId: string): Promise<string> {
    const dir = `${FileSystem.documentDirectory}evidence/${evidenceId}/attachments/`;
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return dir;
  },

  async saveEvidenceLocally(evidence: Evidence, attachments: EvidenceAttachment[]): Promise<void> {
    try {
      const storedEvidence = await AsyncStorage.getItem(EVIDENCE_KEY);
      const evidenceList: Evidence[] = storedEvidence ? JSON.parse(storedEvidence) : [];
      evidenceList.push(evidence);
      await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify(evidenceList));

      if (attachments.length > 0) {
        const storedAttachments = await AsyncStorage.getItem(ATTACHMENTS_KEY);
        const attachmentsList: EvidenceAttachment[] = storedAttachments ? JSON.parse(storedAttachments) : [];
        attachmentsList.push(...attachments);
        await AsyncStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachmentsList));
      }
    } catch (error) {
      console.error("Local storage error:", error);
      throw new Error("Failed to save local evidence metadata.");
    }
  },

  async copyFileToLocalEvidence(sourceUri: string, evidenceId: string, filename: string): Promise<string> {
    const targetDir = await this.ensureDirectoryExists(evidenceId);
    const destinationUri = `${targetDir}${filename}`;
    await FileSystem.copyAsync({ from: sourceUri, to: destinationUri });
    
    const verify = await FileSystem.getInfoAsync(destinationUri);
    if (!verify.exists) {
      throw new Error("File copy failed or file is inaccessible.");
    }
    
    return destinationUri;
  },

  async getLocalEvidence(): Promise<Evidence[]> {
    try {
      const stored = await AsyncStorage.getItem(EVIDENCE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('Recovered from corrupted local evidence metadata cache:', err);
      // Phase 23 Self-heal: Reset corrupt cache to prevent application crash
      await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify([]));
      return [];
    }
  },

  async getLocalEvidenceById(evidenceId: string): Promise<{ evidence: Evidence; attachments: EvidenceAttachment[] } | null> {
    try {
      if (!evidenceId) return null;
      const targetId = evidenceId.trim();

      const allEvidence = await this.getLocalEvidence();
      let evidence = allEvidence.find(e => 
        (e.evidenceId || (e as any).evidence_id) === targetId ||
        (e.id && e.id === targetId)
      );

      // Check secondary local cache (@local_evidence_cache) if not found in primary metadata store
      if (!evidence) {
        try {
          const cachedRaw = await AsyncStorage.getItem('@local_evidence_cache');
          if (cachedRaw) {
            const cachedList = JSON.parse(cachedRaw);
            const cached = Array.isArray(cachedList)
              ? cachedList.find((c: any) => 
                  (c.evidence_id || c.evidenceId) === targetId ||
                  (c.id && c.id === targetId)
                )
              : null;

            if (cached) {
              evidence = {
                id: cached.id,
                evidenceId: cached.evidence_id || cached.evidenceId || targetId,
                teamId: cached.team_id || cached.teamId,
                ownerId: cached.owner_id || cached.ownerId,
                createdBy: cached.created_by || cached.createdBy || cached.owner_id || cached.ownerId,
                created_by: cached.created_by || cached.createdBy,
                assignedOfficerId: cached.assigned_officer_id || cached.assignedOfficerId,
                title: cached.title || '',
                description: cached.description || '',
                category: cached.category || 'General',
                location: cached.location || '',
                capturedAt: cached.captured_at || cached.capturedAt || cached.created_at || new Date().toISOString(),
                status: cached.status || 'ACTIVE',
                verificationStatus: cached.verification_status || cached.verificationStatus || 'PENDING',
                cloudVerificationStatus: cached.cloud_verification_status || cached.cloudVerificationStatus || 'NOT_VERIFIED',
                syncStatus: cached._syncStatus || cached.syncStatus || 'PENDING',
                createdAt: cached.created_at || cached.createdAt || new Date().toISOString(),
                updatedAt: cached.updated_at || cached.updatedAt || new Date().toISOString(),
              };
            }
          }
        } catch (cacheErr) {
          console.warn('Could not read secondary @local_evidence_cache:', cacheErr);
        }
      }

      if (!evidence) return null;

      const storedAttachments = await AsyncStorage.getItem(ATTACHMENTS_KEY);
      const allAttachments: EvidenceAttachment[] = storedAttachments ? JSON.parse(storedAttachments) : [];
      const primaryKey = evidence.id;
      const businessId = evidence.evidenceId || (evidence as any).evidence_id;

      const attachments = allAttachments.filter(a => {
        const aEvId = a.evidenceId || (a as any).evidence_id;
        return aEvId === targetId || aEvId === businessId || (primaryKey && aEvId === primaryKey);
      });

      return { evidence, attachments };
    } catch (error) {
      console.error('Error reading local evidence by ID:', error);
      return null;
    }
  },

  // OPTIMIZATION 3: Bulk read to prevent N+1 AsyncStorage reads in loops
  async getBulkLocalEvidence(evidenceIds: string[]): Promise<Array<{ evidence: Evidence; attachments: EvidenceAttachment[] }>> {
    try {
      // 1. Cross the asynchronous bridge exactly ONCE
      const [storedEvidence, storedAttachments] = await Promise.all([
        AsyncStorage.getItem(EVIDENCE_KEY),
        AsyncStorage.getItem(ATTACHMENTS_KEY)
      ]);

      const evidenceList: Evidence[] = storedEvidence ? JSON.parse(storedEvidence) : [];
      const attachmentsList: EvidenceAttachment[] = storedAttachments ? JSON.parse(storedAttachments) : [];

      // 2. Build rapid-lookup Maps in memory
      const attachmentMap = new Map<string, EvidenceAttachment[]>();
      attachmentsList.forEach(att => {
        const evId = att.evidenceId || (att as any).evidence_id;
        if (!attachmentMap.has(evId)) attachmentMap.set(evId, []);
        attachmentMap.get(evId)!.push(att);
      });

      const evidenceMap = new Map<string, { evidence: Evidence; attachments: EvidenceAttachment[] }>();
      evidenceList.forEach(ev => {
        const evId = ev.evidenceId || (ev as any).evidence_id;
        evidenceMap.set(evId, {
          evidence: ev,
          attachments: attachmentMap.get(evId) || []
        });
      });

      // 3. Map the requested IDs directly without filtering the whole array N times
      return evidenceIds
        .map(id => evidenceMap.get(id))
        .filter((item): item is { evidence: Evidence; attachments: EvidenceAttachment[] } => Boolean(item));
        
    } catch (error) {
      console.error("Bulk read error:", error);
      return [];
    }
  },

  async updateAttachmentMetadata(attachmentId: string, updates: Partial<EvidenceAttachment>): Promise<void> {
    try {
      const storedAttachments = await AsyncStorage.getItem(ATTACHMENTS_KEY);
      if (!storedAttachments) return;
      
      const attachmentsList: EvidenceAttachment[] = JSON.parse(storedAttachments);
      const index = attachmentsList.findIndex(a => (a.attachmentId || (a as any).attachment_id) === attachmentId);
      
      if (index !== -1) {
        attachmentsList[index] = { ...attachmentsList[index], ...updates, updatedAt: new Date().toISOString() };
        await AsyncStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachmentsList));
      }
    } catch (err) {
      console.error('Failed to update attachment metadata locally:', err);
    }
  },

  async updateEvidenceVerificationStatus(evidenceId: string, status: VerificationStatus): Promise<void> {
    try {
      const storedEvidence = await AsyncStorage.getItem(EVIDENCE_KEY);
      if (!storedEvidence) return;

      const evidenceList: Evidence[] = JSON.parse(storedEvidence);
      const index = evidenceList.findIndex(e => (e.evidenceId || (e as any).evidence_id) === evidenceId);

      if (index !== -1) {
        evidenceList[index].verificationStatus = status;
        evidenceList[index].updatedAt = new Date().toISOString();
        await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify(evidenceList));
      }
    } catch (err) {
      console.error('Failed to update evidence verification status locally:', err);
    }
  },

  async updateSyncStatus(evidenceId: string, status: 'LOCAL_ONLY' | 'PENDING' | 'SYNCED' | 'FAILED', lastSyncedAt?: string, syncError?: string): Promise<void> {
    try {
      const storedEvidence = await AsyncStorage.getItem(EVIDENCE_KEY);
      if (!storedEvidence) return;

      const evidenceList: Evidence[] = JSON.parse(storedEvidence);
      const index = evidenceList.findIndex(e => (e.evidenceId || (e as any).evidence_id) === evidenceId);

      if (index !== -1) {
        evidenceList[index].syncStatus = status;
        
        if (lastSyncedAt) {
          evidenceList[index].lastSyncedAt = lastSyncedAt;
        }
        
        if (syncError !== undefined) {
          evidenceList[index].syncError = syncError;
        } else {
          delete evidenceList[index].syncError;
        }
        
        evidenceList[index].updatedAt = new Date().toISOString();
        await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify(evidenceList));
      }
    } catch (err) {
      console.error('Failed to update local sync status:', err);
    }
  }
};
