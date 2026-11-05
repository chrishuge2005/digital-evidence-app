export interface EvidenceSearchParams {
  query?: string;
  teamId?: string;
  ownerId?: string;
  status?: string;
  verificationStatus?: string;
  category?: string;
  scope?: 'ALL' | 'YOURS' | 'TRANSFERS';
  page: number;
  limit: number;
}

export interface TeamAnalytics {
  totalOfficers?: number;
  activeOfficers: number;
  totalEvidence: number;
  pendingVerify: number;
  verified: number;
  failedVerify: number;
  pendingVerification?: number;
  verifiedEvidence?: number;
  integrityFailed?: number;
  pendingTransfers: number;
  acceptedTransfers?: number;
  pendingDeletes: number;
  approvedDeletes?: number;
  recentActivityCount?: number;
}

export interface OfficerAnalytics {
  totalEvidence: number;
  verified: number;
  pendingTransfers: number;
  pendingDeletes: number;
}