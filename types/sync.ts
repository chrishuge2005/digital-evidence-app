export type SyncOperationType = 
  | 'CREATE_EVIDENCE' 
  | 'UPLOAD_ATTACHMENT' 
  | 'CREATE_CUSTODY'
  | 'CREATE_AUDIT_LOG'; // Phase 21 addition

export type SyncStatus = 
  | 'PENDING' 
  | 'SYNCING' 
  | 'SYNCED' 
  | 'FAILED' 
  | 'CONFLICT';

export interface SyncTask {
  syncId: string;
  type: SyncOperationType;
  entityId: string;
  payload: any;
  status: SyncStatus;
  retryCount: number;
  createdAt: number;
  lastAttemptAt?: number;
  lastError?: string;
}