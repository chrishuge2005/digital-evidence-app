export type AuditAction = 
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'LOGIN_FAILED'
  | 'EVIDENCE_CREATED'
  | 'EVIDENCE_UPDATED'
  | 'EVIDENCE_VIEWED'
  | 'EVIDENCE_VERIFIED'
  | 'EVIDENCE_VERIFICATION_FAILED'
  | 'ATTACHMENT_ADDED'
  | 'ATTACHMENT_UPLOADED'
  | 'ATTACHMENT_UPLOAD_FAILED'
  | 'CLOUD_VERIFICATION_STARTED'
  | 'CLOUD_EVIDENCE_VERIFIED'
  | 'CLOUD_EVIDENCE_VERIFICATION_FAILED'
  | 'TRANSFER_REQUESTED'
  | 'TRANSFER_ACCEPTED'
  | 'TRANSFER_REJECTED'
  | 'EVIDENCE_RECEIVED'
  | 'DELETION_REQUESTED'
  | 'DELETION_APPROVED'
  | 'DELETION_REJECTED'
  | 'EVIDENCE_DELETED'
  | 'OFFICER_ADDED'
  | 'OFFICER_REMOVED'
  | 'OFFICER_DEACTIVATED'
  | 'UNAUTHORIZED_ACCESS_ATTEMPT'
  | 'RLS_ACCESS_DENIED'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED'
  | 'SYNC_CONFLICT';

export type AuditStatus = 'SUCCESS' | 'FAILED' | 'DENIED' | 'PENDING';

export interface AuditLog {
  id: string;
  team_id: string;
  evidence_id?: string;
  actor_user_id: string;
  actor_name: string;
  actor_role: string;
  action: AuditAction;
  status: AuditStatus;
  description?: string;
  target_user_id?: string;
  target_user_name?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export type AuditCreateInput = Omit<AuditLog, 'id' | 'created_at'>;