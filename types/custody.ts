export type CustodyAction =
  | "EVIDENCE_REGISTERED"
  | "EVIDENCE_REVIEWED"
  | "EVIDENCE_VERIFIED"
  | "EVIDENCE_VERIFICATION_FAILED"
  | "CLOUD_EVIDENCE_VERIFIED"
  | "CLOUD_EVIDENCE_VERIFICATION_FAILED"
  | "EVIDENCE_TRANSFER_REQUESTED"
  | "EVIDENCE_TRANSFER_ACCEPTED"
  | "EVIDENCE_TRANSFER_REJECTED"
  | "EVIDENCE_RECEIVED"
  | "DELETION_REQUESTED"
  | "DELETION_APPROVED"
  | "DELETION_REJECTED"
  | "EVIDENCE_DELETED";

export interface CustodyEvent {
  custodyId: string;
  evidenceId: string;
  teamId: string;
  action: CustodyAction;
  performedByUserId: string;
  performedBy: string;
  role: "OFFICER" | "HIGHER_OFFICER" | string;
  timestamp: string;
  status: "SUCCESS" | "FAILED" | string;
  notes?: string;
  recipientUserId?: string;
  recipientName?: string;
  recipientRole?: "OFFICER" | "HIGHER_OFFICER" | string;
  syncStatus?: "LOCAL_ONLY" | "PENDING" | "SYNCED" | "FAILED";
  lastSyncedAt?: string;
  syncError?: string;
}