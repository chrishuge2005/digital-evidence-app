export type SyncStatus = 'LOCAL_ONLY' | 'PENDING' | 'SYNCED' | 'FAILED';

export type VerificationStatus = 
  | 'PENDING' 
  | 'VERIFIED' 
  | 'REJECTED' 
  | 'INTEGRITY_FAILED' 
  | 'UNAVAILABLE' 
  | 'PARTIALLY_VERIFIED';

export type CloudVerificationStatus = 
  | 'NOT_VERIFIED' 
  | 'VERIFIED' 
  | 'INTEGRITY_FAILED' 
  | 'UNAVAILABLE';

export interface EvidenceAttachment {
  id?: string;
  attachmentId: string;
  evidenceId: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  localUri: string;
  storageFileId?: string | null;
  storagePath?: string | null;
  sha256: string; // IMMUTABLE original fingerprint
  uploadStatus: string;
  cloudVerificationStatus?: CloudVerificationStatus | string;
  cloudLastVerifiedHash?: string | null;
  cloudLastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id?: string;
  evidenceId: string;
  teamId: string;
  ownerId: string;
  created_by?: string;
  createdBy?: string;
  assignedOfficerId?: string;
  title: string;
  description: string;
  category: string;
  location: string;
  capturedAt: string;
  uploadedAt?: string;
  status: string;
  verificationStatus: VerificationStatus;
  cloudVerificationStatus?: CloudVerificationStatus | string;
  syncStatus: SyncStatus;
  lastSyncedAt?: string;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustodyEvent {
  custodyId?: string;
  evidenceId: string;
  teamId: string;
  action: string;
  performedByUserId: string;
  performedBy: string;
  role: string;
  timestamp: string;
  status: string;
  notes?: string;
  recipientUserId?: string;
  recipientName?: string;
  recipientRole?: string;
  syncStatus: SyncStatus;
  lastSyncedAt?: string;
  syncError?: string;
}

export type HashStatus = 'NOT_CALCULATED' | 'CALCULATED' | 'FAILED';