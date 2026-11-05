-- BACKUP OF 01_database_schema.sql
-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - SUPABASE DATABASE SCHEMA
-- File: 01_database_schema.sql
-- Description: Core tables, columns, constraints, foreign keys, and indexes.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. USER PROFILES TABLE
-- Linked 1:1 with auth.users. Stores application-specific officer details and roles.
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'OFFICER' CHECK (role IN ('OFFICER', 'HIGHER_OFFICER', 'officer', 'higher_officer')),
    team_id UUID,
    badge_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. TEAMS TABLE
-- Units / departments overseen by a supervisor Higher Officer.
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    team_code TEXT NOT NULL UNIQUE,
    higher_officer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add foreign key constraint from profiles to teams if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_profiles_team'
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT fk_profiles_team FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 4. TEAM MEMBERS TABLE
-- Supports multi-officer roster tracking and strict team quota enforcement.
CREATE TABLE IF NOT EXISTS public.team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'OFFICER' CHECK (role IN ('OFFICER', 'HIGHER_OFFICER')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    CONSTRAINT uq_team_member UNIQUE (team_id, user_id)
);

-- 5. EVIDENCE RECORDS TABLE
-- Master catalog of registered digital evidence items.
CREATE TABLE IF NOT EXISTS public.evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL UNIQUE,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    assigned_officer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'General',
    location TEXT,
    captured_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING', 'TRANSFERRED', 'DELETED', 'ARCHIVED')),
    verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'INTEGRITY_FAILED', 'UNAVAILABLE', 'PARTIALLY_VERIFIED')),
    cloud_verification_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (cloud_verification_status IN ('NOT_VERIFIED', 'VERIFIED', 'INTEGRITY_FAILED', 'UNAVAILABLE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. EVIDENCE ATTACHMENTS TABLE
-- Binary file records, cryptographic SHA-256 fingerprints, and storage references.
CREATE TABLE IF NOT EXISTS public.evidence_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id TEXT NOT NULL UNIQUE,
    evidence_id UUID NOT NULL REFERENCES public.evidence(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    file_size BIGINT,
    local_uri TEXT,
    storage_file_id TEXT,
    sha256 TEXT NOT NULL,
    upload_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (upload_status IN ('PENDING', 'UPLOADING', 'UPLOADED', 'FAILED')),
    cloud_verification_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (cloud_verification_status IN ('NOT_VERIFIED', 'VERIFIED', 'INTEGRITY_FAILED', 'UNAVAILABLE')),
    cloud_last_verified_hash TEXT,
    cloud_last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. EVIDENCE CUSTODY EVENTS TABLE
-- Immutable legal chain of custody ledger tracking every action, review, transfer, and status change.
CREATE TABLE IF NOT EXISTS public.evidence_custody (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custody_id TEXT NOT NULL UNIQUE,
    evidence_id UUID NOT NULL REFERENCES public.evidence(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    performed_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    performed_by TEXT NOT NULL,
    role TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    notes TEXT,
    recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    recipient_name TEXT,
    recipient_role TEXT,
    hash_at_event TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. TRANSFER REQUESTS TABLE
-- Two-step custody transfer protocol requiring explicit recipient confirmation.
CREATE TABLE IF NOT EXISTS public.transfer_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    response_notes TEXT
);

-- 9. DELETION REQUESTS TABLE
-- Dual-authorization deletion workflow (Officer requests, Higher Officer approves).
CREATE TABLE IF NOT EXISTS public.deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    requested_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    requested_by_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_by_name TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    response_notes TEXT
);

-- 10. NOTIFICATIONS TABLE
-- Real-time in-app alerts for pending transfers, deletion requests, and system events.
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    evidence_id TEXT,
    transfer_request_id UUID REFERENCES public.transfer_requests(id) ON DELETE SET NULL,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. BLOCKCHAIN ANCHORS TABLE
-- Queue and confirmation ledger for Ethereum/EVM smart contract notarizations.
CREATE TABLE IF NOT EXISTS public.blockchain_anchors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL,
    team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    anchor_type TEXT NOT NULL DEFAULT 'EVIDENCE' CHECK (anchor_type IN ('EVIDENCE', 'CUSTODY')),
    reference_id TEXT,
    data_hash TEXT NOT NULL,
    blockchain_network TEXT DEFAULT 'evm_network',
    chain_id TEXT DEFAULT '31337',
    contract_address TEXT,
    transaction_hash TEXT,
    block_number BIGINT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ
);

-- 12. AUDIT LOGS TABLE
-- Global immutable security and compliance audit journal.
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    evidence_id TEXT,
    actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    description TEXT,
    target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    target_user_name TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 13. PERFORMANCE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_team_id ON public.profiles(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_higher_officer ON public.teams(higher_officer_id);
CREATE INDEX IF NOT EXISTS idx_teams_code ON public.teams(team_code);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_evidence_team ON public.evidence(team_id);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON public.evidence(owner_id);
CREATE INDEX IF NOT EXISTS idx_evidence_created_by ON public.evidence(created_by);
CREATE INDEX IF NOT EXISTS idx_evidence_evidence_id ON public.evidence(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_attachments_ev ON public.evidence_attachments(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_attachments_att_id ON public.evidence_attachments(attachment_id);
CREATE INDEX IF NOT EXISTS idx_evidence_custody_ev ON public.evidence_custody(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_custody_team ON public.evidence_custody(team_id);
CREATE INDEX IF NOT EXISTS idx_evidence_custody_timestamp ON public.evidence_custody(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_team ON public.transfer_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON public.transfer_requests(status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_recipient ON public.transfer_requests(to_user_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_team ON public.deletion_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON public.deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON public.notifications(recipient_user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_blockchain_anchors_status ON public.blockchain_anchors(status);
CREATE INDEX IF NOT EXISTS idx_blockchain_anchors_ev ON public.blockchain_anchors(evidence_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_team ON public.audit_logs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ev ON public.audit_logs(evidence_id);
