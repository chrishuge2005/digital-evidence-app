-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT & CHAIN OF CUSTODY SYSTEM
-- COMPLETE DATABASE DEPLOYMENT SCRIPT (ALL-IN-ONE REPAIRED VERSION)
-- File: 05_complete_setup.sql
-- Description: Consolidated, ordered, and idempotent deployment script for Supabase.
-- Execution: Copy and paste directly into Supabase Dashboard -> SQL Editor -> New Query.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. EXTENSIONS & SAFE CAST UTILITIES
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Safe UUID cast: returns NULL instead of raising unhandled casting errors on invalid input
CREATE OR REPLACE FUNCTION public.safe_cast_uuid(p_val TEXT)
RETURNS UUID AS $$
BEGIN
    IF p_val IS NOT NULL AND p_val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN p_val::uuid;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- 2. CORE DATABASE SCHEMA & TABLES
-- ============================================================================

-- 2.1 Profiles Table (Linked 1:1 with auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'OFFICER' CHECK (role IN ('OFFICER', 'HIGHER_OFFICER')),
    team_id UUID,
    badge_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.2 Teams Table (Department unit overseen by Higher Officer)
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    team_code TEXT NOT NULL UNIQUE,
    higher_officer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Foreign key linking profiles to teams
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_profiles_team'
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT fk_profiles_team FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 2.3 Team Members Table (Multi-officer rosters & strict 5-officer quota enforcement)
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

-- 2.4 Evidence Records Table (Master evidence catalog)
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

-- 2.5 Evidence Attachments Table (Files, cryptographic hashes, and storage paths)
CREATE TABLE IF NOT EXISTS public.evidence_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id TEXT NOT NULL UNIQUE,
    evidence_id UUID NOT NULL REFERENCES public.evidence(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    file_size BIGINT NOT NULL CONSTRAINT chk_attachment_file_size CHECK (file_size > 0 AND file_size <= 52428800), -- Max 50 MB
    local_uri TEXT,
    storage_file_id TEXT,
    sha256 TEXT NOT NULL CONSTRAINT chk_attachment_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$'), -- 64-char lowercase hex
    upload_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (upload_status IN ('PENDING', 'UPLOADING', 'UPLOADED', 'FAILED')),
    cloud_verification_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (cloud_verification_status IN ('NOT_VERIFIED', 'VERIFIED', 'INTEGRITY_FAILED', 'UNAVAILABLE')),
    cloud_last_verified_hash TEXT,
    cloud_last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.6 Evidence Custody Events Table (Forensic append-only audit trail)
-- Uses ON DELETE RESTRICT on evidence_id to ensure chain of custody is permanently preserved
CREATE TABLE IF NOT EXISTS public.evidence_custody (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custody_id TEXT NOT NULL UNIQUE,
    evidence_id UUID NOT NULL REFERENCES public.evidence(id) ON DELETE RESTRICT,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    performed_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    performed_by TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OFFICER', 'HIGHER_OFFICER')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    notes TEXT,
    recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    recipient_name TEXT,
    recipient_role TEXT CHECK (recipient_role IS NULL OR recipient_role IN ('OFFICER', 'HIGHER_OFFICER')),
    hash_at_event TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.7 Transfer Requests Table (Two-step custody transfer protocol)
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

-- 2.8 Deletion Requests Table (Dual-authorization deletion approval workflow)
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

-- 2.9 Notifications Table (In-app alerts for transfers and approvals)
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

-- 2.10 Blockchain Anchors Table (Ethereum/EVM notarization ledger)
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

-- 2.11 Audit Logs Table (Compliance audit log)
-- team_id is nullable for global/user-level events (e.g. unassigned officer promotions)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES public.teams(id) ON DELETE RESTRICT,
    evidence_id TEXT,
    actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL CHECK (actor_role IN ('OFFICER', 'HIGHER_OFFICER', 'SYSTEM')),
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    description TEXT,
    target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    target_user_name TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. INDEXES FOR QUERY OPTIMIZATION
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_lower_email ON public.profiles (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_profiles_team_id ON public.profiles(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_higher_officer ON public.teams(higher_officer_id);
CREATE INDEX IF NOT EXISTS idx_teams_code ON public.teams(team_code);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_active_officer ON public.team_members (user_id) WHERE (status = 'ACTIVE' AND role = 'OFFICER');
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

-- ============================================================================
-- 4. SECURE HELPER FUNCTIONS (RECURSION-SAFE & PRIVILEGE-CHECKED)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_auth_user_id()
RETURNS UUID AS $$
    SELECT auth.uid();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.get_user_role(p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_target_id UUID := COALESCE(p_user_id, auth.uid());
    v_role TEXT;
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN 'OFFICER';
    END IF;

    IF v_caller_id = v_target_id THEN
        SELECT role INTO v_role
        FROM public.profiles
        WHERE user_id = v_target_id;
        RETURN COALESCE(v_role, 'OFFICER');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.profiles WHERE user_id = v_caller_id AND role = 'HIGHER_OFFICER'
    ) OR EXISTS (
        SELECT 1 FROM public.team_members tm1
        JOIN public.team_members tm2 ON tm1.team_id = tm2.team_id
        WHERE tm1.user_id = v_caller_id AND tm2.user_id = v_target_id AND tm1.status = 'ACTIVE' AND tm2.status = 'ACTIVE'
    ) THEN
        SELECT role INTO v_role
        FROM public.profiles
        WHERE user_id = v_target_id;
        RETURN COALESCE(v_role, 'OFFICER');
    END IF;

    RETURN 'OFFICER';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

CREATE OR REPLACE FUNCTION public.is_higher_officer(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
DECLARE
    v_target_id UUID := COALESCE(p_user_id, auth.uid());
    v_role TEXT;
BEGIN
    IF v_target_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT role INTO v_role
    FROM public.profiles
    WHERE user_id = v_target_id;

    RETURN (v_role = 'HIGHER_OFFICER');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

CREATE OR REPLACE FUNCTION public.get_user_team_ids(p_user_id UUID DEFAULT auth.uid())
RETURNS SETOF UUID AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_target_id UUID := COALESCE(p_user_id, auth.uid());
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN;
    END IF;

    IF v_caller_id != v_target_id AND NOT public.is_higher_officer(v_caller_id) THEN
        v_target_id := v_caller_id;
    END IF;

    RETURN QUERY
    SELECT team_id FROM public.team_members
    WHERE user_id = v_target_id AND status = 'ACTIVE'
    UNION
    SELECT id AS team_id FROM public.teams
    WHERE higher_officer_id = v_target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

CREATE OR REPLACE FUNCTION public.is_user_in_team(p_team_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
DECLARE
    v_target_id UUID := COALESCE(p_user_id, auth.uid());
BEGIN
    IF p_team_id IS NULL OR v_target_id IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.team_members
        WHERE team_id = p_team_id
          AND user_id = v_target_id
          AND status = 'ACTIVE'
    ) OR EXISTS (
        SELECT 1 FROM public.teams
        WHERE id = p_team_id
          AND higher_officer_id = v_target_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

CREATE OR REPLACE FUNCTION public.find_officer_by_email(p_email TEXT)
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    display_name TEXT,
    role TEXT
) AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_clean_email TEXT := LOWER(TRIM(p_email));
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    RETURN QUERY
    SELECT p.user_id, p.email, p.display_name, p.role
    FROM public.profiles p
    WHERE LOWER(p.email) = v_clean_email;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

CREATE OR REPLACE FUNCTION public.lookup_team_by_code(p_team_code TEXT)
RETURNS TABLE (
    id UUID,
    name TEXT,
    team_code TEXT,
    higher_officer_id UUID
) AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_clean_code TEXT := TRIM(p_team_code);
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    RETURN QUERY
    SELECT t.id, t.name, t.team_code, t.higher_officer_id
    FROM public.teams t
    WHERE t.team_code = v_clean_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

REVOKE ALL ON FUNCTION public.get_auth_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_role(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_higher_officer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_team_ids(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_user_in_team(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_officer_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_team_by_code(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_higher_officer(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_team_ids(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_user_in_team(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_officer_by_email(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lookup_team_by_code(TEXT) TO authenticated, service_role;

-- ============================================================================
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blockchain_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Target-specific policy cleanup
DO $$
DECLARE
    r RECORD;
    t TEXT;
    target_tables TEXT[] := ARRAY[
        'profiles', 'teams', 'team_members', 'evidence', 
        'evidence_attachments', 'evidence_custody', 'transfer_requests', 
        'deletion_requests', 'notifications', 'blockchain_anchors', 'audit_logs'
    ];
BEGIN
    FOREACH t IN ARRAY target_tables LOOP
        FOR r IN (SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t) LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
        END LOOP;
    END LOOP;
END $$;

-- 5.1 Profiles Policies
CREATE POLICY "profiles_select_policy"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (
        auth.uid() = user_id
        OR user_id IN (
            SELECT tm.user_id FROM public.team_members tm 
            WHERE tm.team_id IN (SELECT public.get_user_team_ids())
              AND tm.status = 'ACTIVE'
        )
        OR user_id IN (
            SELECT t.higher_officer_id FROM public.teams t 
            WHERE t.id IN (SELECT public.get_user_team_ids())
        )
    );

CREATE POLICY "profiles_insert_policy"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = user_id 
        AND role = 'OFFICER'
    );

CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id
        AND role = (SELECT p.role FROM public.profiles p WHERE p.user_id = auth.uid())
        AND user_id = (SELECT p.user_id FROM public.profiles p WHERE p.user_id = auth.uid())
    );

-- 5.2 Teams Policies
CREATE POLICY "teams_select_policy"
    ON public.teams FOR SELECT
    TO authenticated
    USING (
        id IN (SELECT public.get_user_team_ids())
    );

CREATE POLICY "teams_insert_policy"
    ON public.teams FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    );

CREATE POLICY "teams_update_policy"
    ON public.teams FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    )
    WITH CHECK (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    );

-- 5.3 Team Members Policies
CREATE POLICY "team_members_select_policy"
    ON public.team_members FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        OR user_id = auth.uid()
    );

CREATE POLICY "team_members_insert_policy"
    ON public.team_members FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = team_members.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
        AND public.is_higher_officer(auth.uid())
    );

CREATE POLICY "team_members_update_policy"
    ON public.team_members FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = team_members.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
        AND public.is_higher_officer(auth.uid())
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = team_members.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
        AND public.is_higher_officer(auth.uid())
        AND user_id = (SELECT tm.user_id FROM public.team_members tm WHERE tm.id = team_members.id)
        AND team_id = (SELECT tm.team_id FROM public.team_members tm WHERE tm.id = team_members.id)
    );

-- 5.4 Evidence Policies
CREATE POLICY "evidence_select_policy"
    ON public.evidence FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

CREATE POLICY "evidence_insert_policy"
    ON public.evidence FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = owner_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

CREATE POLICY "evidence_update_policy"
    ON public.evidence FOR UPDATE
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        AND (
            auth.uid() = owner_id 
            OR public.is_higher_officer(auth.uid())
        )
        AND status != 'DELETED'
    )
    WITH CHECK (
        team_id IN (SELECT public.get_user_team_ids())
        AND (
            auth.uid() = owner_id 
            OR public.is_higher_officer(auth.uid())
        )
        AND status != 'DELETED'
        AND status IN ('ACTIVE', 'PENDING', 'ARCHIVED')
        AND (status != 'ARCHIVED' OR public.is_higher_officer(auth.uid()))
    );

-- 5.5 Evidence Attachments Policies
CREATE POLICY "evidence_attachments_select_policy"
    ON public.evidence_attachments FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.evidence e 
            WHERE e.id = evidence_attachments.evidence_id 
              AND e.team_id IN (SELECT public.get_user_team_ids())
        )
    );

CREATE POLICY "evidence_attachments_insert_policy"
    ON public.evidence_attachments FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.evidence e 
            WHERE e.id = evidence_attachments.evidence_id 
              AND public.is_user_in_team(e.team_id, auth.uid())
        )
    );

CREATE POLICY "evidence_attachments_update_policy"
    ON public.evidence_attachments FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.evidence e 
            WHERE e.id = evidence_attachments.evidence_id 
              AND e.team_id IN (SELECT public.get_user_team_ids())
              AND (e.owner_id = auth.uid() OR public.is_higher_officer(auth.uid()))
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.evidence e 
            WHERE e.id = evidence_attachments.evidence_id 
              AND e.team_id IN (SELECT public.get_user_team_ids())
              AND (e.owner_id = auth.uid() OR public.is_higher_officer(auth.uid()))
        )
    );

-- 5.6 Evidence Custody Policies (Append-Only)
CREATE POLICY "evidence_custody_select_policy"
    ON public.evidence_custody FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

CREATE POLICY "evidence_custody_insert_policy"
    ON public.evidence_custody FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = performed_by_user_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

-- 5.7 Transfer Requests Policies
CREATE POLICY "transfer_requests_select_policy"
    ON public.transfer_requests FOR SELECT
    TO authenticated
    USING (
        auth.uid() = from_user_id 
        OR auth.uid() = to_user_id
        OR (team_id IN (SELECT public.get_user_team_ids()) AND public.is_higher_officer(auth.uid()))
    );

CREATE POLICY "transfer_requests_insert_policy"
    ON public.transfer_requests FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = from_user_id
        AND auth.uid() != to_user_id
        AND public.is_user_in_team(team_id, auth.uid())
        AND public.is_user_in_team(team_id, to_user_id)
        AND EXISTS (
            SELECT 1 FROM public.evidence e
            WHERE e.evidence_id = transfer_requests.evidence_id
              AND e.team_id = transfer_requests.team_id
              AND e.owner_id = auth.uid()
        )
    );

CREATE POLICY "transfer_requests_update_policy"
    ON public.transfer_requests FOR UPDATE
    TO authenticated
    USING (
        (auth.uid() = to_user_id OR auth.uid() = from_user_id)
        AND status = 'PENDING'
    )
    WITH CHECK (
        from_user_id = (SELECT tr.from_user_id FROM public.transfer_requests tr WHERE tr.id = transfer_requests.id)
        AND to_user_id = (SELECT tr.to_user_id FROM public.transfer_requests tr WHERE tr.id = transfer_requests.id)
        AND evidence_id = (SELECT tr.evidence_id FROM public.transfer_requests tr WHERE tr.id = transfer_requests.id)
        AND team_id = (SELECT tr.team_id FROM public.transfer_requests tr WHERE tr.id = transfer_requests.id)
    );

-- 5.8 Deletion Requests Policies
CREATE POLICY "deletion_requests_select_policy"
    ON public.deletion_requests FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

CREATE POLICY "deletion_requests_insert_policy"
    ON public.deletion_requests FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = requested_by_user_id
        AND public.is_user_in_team(team_id, auth.uid())
        AND EXISTS (
            SELECT 1 FROM public.evidence e 
            WHERE e.evidence_id = deletion_requests.evidence_id 
              AND e.team_id = deletion_requests.team_id
        )
    );

-- Deletion approval/rejection is executed EXCLUSIVELY through trusted RPCs:
-- `approve_evidence_deletion` and `reject_evidence_deletion`.
-- Direct client updates cannot transition requests to APPROVED or REJECTED.
-- Requesters can only cancel their own pending requests.
CREATE POLICY "deletion_requests_update_policy"
    ON public.deletion_requests FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = requested_by_user_id
        AND status = 'PENDING'
    )
    WITH CHECK (
        auth.uid() = requested_by_user_id
        AND status = 'CANCELLED'
        AND team_id = (SELECT dr.team_id FROM public.deletion_requests dr WHERE dr.id = deletion_requests.id)
        AND evidence_id = (SELECT dr.evidence_id FROM public.deletion_requests dr WHERE dr.id = deletion_requests.id)
    );

-- 5.9 Notifications Policies
CREATE POLICY "notifications_select_policy"
    ON public.notifications FOR SELECT
    TO authenticated
    USING (
        recipient_user_id = auth.uid()
    );

CREATE POLICY "notifications_insert_policy"
    ON public.notifications FOR INSERT
    TO authenticated
    WITH CHECK (
        recipient_user_id IN (
            SELECT tm.user_id FROM public.team_members tm
            WHERE tm.team_id IN (SELECT public.get_user_team_ids())
            UNION
            SELECT t.higher_officer_id FROM public.teams t
            WHERE t.id IN (SELECT public.get_user_team_ids())
        )
    );

CREATE POLICY "notifications_update_policy"
    ON public.notifications FOR UPDATE
    TO authenticated
    USING (
        recipient_user_id = auth.uid()
    )
    WITH CHECK (
        recipient_user_id = auth.uid()
        AND type = (SELECT n.type FROM public.notifications n WHERE n.id = notifications.id)
        AND title = (SELECT n.title FROM public.notifications n WHERE n.id = notifications.id)
        AND message = (SELECT n.message FROM public.notifications n WHERE n.id = notifications.id)
    );

-- 5.10 Blockchain Anchors Policies
CREATE POLICY "blockchain_anchors_select_policy"
    ON public.blockchain_anchors FOR SELECT
    TO authenticated
    USING (
        team_id IS NULL 
        OR team_id IN (SELECT public.get_user_team_ids())
    );

CREATE POLICY "blockchain_anchors_insert_policy"
    ON public.blockchain_anchors FOR INSERT
    TO authenticated
    WITH CHECK (
        status = 'PENDING'
        AND transaction_hash IS NULL
        AND block_number IS NULL
        AND (
            team_id IS NULL 
            OR team_id IN (SELECT public.get_user_team_ids())
        )
    );

CREATE POLICY "blockchain_anchors_update_policy"
    ON public.blockchain_anchors FOR UPDATE
    TO authenticated
    USING (
        auth.role() = 'service_role'
    );

-- 5.11 Audit Logs Policies (Append-Only)
-- Higher Officers can view department audit logs; officers can view logs for their own actions or targets
CREATE POLICY "audit_logs_select_policy"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (
        (team_id IS NOT NULL AND team_id IN (SELECT public.get_user_team_ids()) AND public.is_higher_officer(auth.uid()))
        OR actor_user_id = auth.uid()
        OR target_user_id = auth.uid()
    );

CREATE POLICY "audit_logs_insert_policy"
    ON public.audit_logs FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = actor_user_id
        AND (
            team_id IS NULL 
            OR public.is_user_in_team(team_id, auth.uid())
        )
    );

-- ============================================================================
-- 6. BUSINESS LOGIC FUNCTIONS & TRIGGERS
-- ============================================================================

-- 6.1 Updated_at maintenance
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_teams_updated_at ON public.teams;
CREATE TRIGGER trg_teams_updated_at
    BEFORE UPDATE ON public.teams
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_evidence_updated_at ON public.evidence;
CREATE TRIGGER trg_evidence_updated_at
    BEFORE UPDATE ON public.evidence
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Evidence status transition validator and immutability guard
CREATE OR REPLACE FUNCTION public.validate_evidence_status_transition()
RETURNS TRIGGER AS $$
DECLARE
    v_caller_id UUID := auth.uid();
BEGIN
    -- Unconditionally preserve immutable columns against client tampering
    NEW.team_id := OLD.team_id;
    NEW.evidence_id := OLD.evidence_id;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;

    -- Allow owner change only via transfer workflow
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND current_setting('evidence.allow_status_transferred', true) != 'true' THEN
        RAISE EXCEPTION 'Unauthorized ownership modification: Evidence ownership may only be changed through an accepted custody transfer.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- If status is NOT changing:
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    -- If status IS changing:
    -- Cannot modify already deleted evidence
    IF OLD.status = 'DELETED' THEN
        RAISE EXCEPTION 'Evidence record is deleted and cannot be modified.'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Transition to DELETED requires approve_evidence_deletion RPC
    IF NEW.status = 'DELETED' THEN
        IF current_setting('evidence.allow_status_deleted', true) != 'true' THEN
            RAISE EXCEPTION 'Unauthorized status transition: Direct deletion of evidence is prohibited. Deletion must proceed through the supervisor approval workflow.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- Transition to TRANSFERRED requires accept_custody_transfer RPC
    IF NEW.status = 'TRANSFERRED' THEN
        IF current_setting('evidence.allow_status_transferred', true) != 'true' THEN
            RAISE EXCEPTION 'Unauthorized status transition: Transfer status cannot be updated directly.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- Transition to ARCHIVED requires Higher Officer privileges
    IF NEW.status = 'ARCHIVED' THEN
        IF NOT public.is_higher_officer(v_caller_id) THEN
            RAISE EXCEPTION 'Unauthorized: Only Higher Officers may archive evidence records.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_validate_evidence_status_transition ON public.evidence;
CREATE TRIGGER trg_validate_evidence_status_transition
    BEFORE UPDATE ON public.evidence
    FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_status_transition();

DROP TRIGGER IF EXISTS trg_attachments_updated_at ON public.evidence_attachments;
CREATE TRIGGER trg_attachments_updated_at
    BEFORE UPDATE ON public.evidence_attachments
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Evidence attachments immutability guard
CREATE OR REPLACE FUNCTION public.validate_attachment_immutability()
RETURNS TRIGGER AS $$
BEGIN
    -- Unconditionally preserve immutable columns against client tampering
    NEW.evidence_id := OLD.evidence_id;
    NEW.attachment_id := OLD.attachment_id;
    NEW.sha256 := OLD.sha256;
    NEW.file_size := OLD.file_size;
    NEW.created_at := OLD.created_at;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_validate_attachment_immutability ON public.evidence_attachments;
CREATE TRIGGER trg_validate_attachment_immutability
    BEFORE UPDATE ON public.evidence_attachments
    FOR EACH ROW EXECUTE FUNCTION public.validate_attachment_immutability();

-- 6.2 Profile auto-creation on signup (Default 'OFFICER')
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_name TEXT;
BEGIN
    v_name := COALESCE(
        NEW.raw_user_meta_data->>'display_name',
        NEW.raw_user_meta_data->>'full_name',
        split_part(NEW.email, '@', 1)
    );

    INSERT INTO public.profiles (user_id, email, display_name, role)
    VALUES (NEW.id, NEW.email, v_name, 'OFFICER')
    ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = COALESCE(public.profiles.display_name, EXCLUDED.display_name),
        updated_at = now();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 6.3 Higher Officer Promotion Procedure
CREATE OR REPLACE FUNCTION public.promote_officer_to_higher_officer(p_target_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_target_profile RECORD;
    v_caller_profile RECORD;
    v_audit_team_id UUID;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Validate caller is an authenticated Higher Officer
    SELECT * INTO v_caller_profile
    FROM public.profiles
    WHERE user_id = v_caller_id;

    IF v_caller_profile IS NULL OR v_caller_profile.role != 'HIGHER_OFFICER' THEN
        RAISE EXCEPTION 'Unauthorized: Only an existing Higher Officer can grant supervisory privileges.';
    END IF;

    -- Cannot promote oneself
    IF v_caller_id = p_target_user_id THEN
        RAISE EXCEPTION 'Invalid promotion: A Higher Officer cannot promote themselves.';
    END IF;

    -- Fetch and lock target officer profile
    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE user_id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target officer profile not found.';
    END IF;

    -- Idempotency check: already Higher Officer
    IF v_target_profile.role = 'HIGHER_OFFICER' THEN
        RETURN jsonb_build_object('success', true, 'message', 'Officer already has Higher Officer privileges.', 'promoted_user_id', p_target_user_id);
    END IF;

    -- Perform role elevation
    UPDATE public.profiles
    SET role = 'HIGHER_OFFICER',
        updated_at = now()
    WHERE user_id = p_target_user_id;

    -- Resolve audit team_id safely: target's team_id, caller's team_id, or NULL for unassigned officers
    v_audit_team_id := COALESCE(v_target_profile.team_id, v_caller_profile.team_id);

    -- Log to audit (nullable team_id without fake UUID crash)
    INSERT INTO public.audit_logs (
        team_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description,
        target_user_id,
        target_user_name,
        metadata
    ) VALUES (
        v_audit_team_id,
        v_caller_id,
        COALESCE(v_caller_profile.display_name, 'Higher Officer'),
        'HIGHER_OFFICER',
        'OFFICER_PROMOTED',
        'SUCCESS',
        format('Officer %s promoted to Higher Officer by %s', COALESCE(v_target_profile.display_name, p_target_user_id::text), COALESCE(v_caller_profile.display_name, v_caller_id::text)),
        p_target_user_id,
        v_target_profile.display_name,
        jsonb_build_object('promoted_user_id', p_target_user_id, 'target_email', v_target_profile.email)
    );

    RETURN jsonb_build_object('success', true, 'promoted_user_id', p_target_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.promote_officer_to_higher_officer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_officer_to_higher_officer(UUID) TO authenticated, service_role;

-- 6.4 5-Officer quota enforcement per team (Row-locked)
CREATE OR REPLACE FUNCTION public.enforce_team_officer_limit()
RETURNS TRIGGER AS $$
DECLARE
    v_officer_count INTEGER;
BEGIN
    IF NEW.role = 'OFFICER' AND NEW.status = 'ACTIVE' THEN
        PERFORM 1 FROM public.teams WHERE id = NEW.team_id FOR UPDATE;

        SELECT COUNT(*) INTO v_officer_count
        FROM public.team_members
        WHERE team_id = NEW.team_id
          AND role = 'OFFICER'
          AND status = 'ACTIVE'
          AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

        IF v_officer_count >= 5 THEN
            RAISE EXCEPTION 'Team capacity exceeded: A department team cannot exceed 5 active officers.'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_enforce_team_officer_limit ON public.team_members;
CREATE TRIGGER trg_enforce_team_officer_limit
    BEFORE INSERT OR UPDATE ON public.team_members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_team_officer_limit();

-- 6.5 Custody and Audit Immutability Guards
CREATE OR REPLACE FUNCTION public.enforce_custody_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Forensic violation: Chain of custody and audit records are immutable and cannot be updated or deleted.'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_update_evidence_custody ON public.evidence_custody;
CREATE TRIGGER trg_no_update_evidence_custody
    BEFORE UPDATE OR DELETE ON public.evidence_custody
    FOR EACH ROW EXECUTE FUNCTION public.enforce_custody_immutability();

DROP TRIGGER IF EXISTS trg_no_update_audit_logs ON public.audit_logs;
CREATE TRIGGER trg_no_update_audit_logs
    BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_custody_immutability();

-- 6.6 Atomic Custody Transfer Procedure
CREATE OR REPLACE FUNCTION public.accept_custody_transfer(
    p_request_id UUID,
    p_evidence_id TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
    v_evidence RECORD;
    v_recipient_name TEXT;
    v_sender_name TEXT;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    SELECT display_name INTO v_recipient_name
    FROM public.profiles
    WHERE user_id = v_caller_id;

    v_recipient_name := COALESCE(v_recipient_name, 'Officer');

    SELECT * INTO v_req
    FROM public.transfer_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer request not found.';
    END IF;

    IF v_req.status != 'PENDING' THEN
        RAISE EXCEPTION 'Transfer request has already been processed (Current status: %).', v_req.status;
    END IF;

    IF v_req.to_user_id != v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: Only the designated recipient can accept this transfer.';
    END IF;

    IF v_req.evidence_id != p_evidence_id THEN
        RAISE EXCEPTION 'Mismatched evidence identifier for transfer request.';
    END IF;

    SELECT * INTO v_evidence
    FROM public.evidence
    WHERE evidence_id = p_evidence_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evidence record not found.';
    END IF;

    IF v_evidence.team_id != v_req.team_id THEN
        RAISE EXCEPTION 'Security violation: Evidence team does not match transfer request team.';
    END IF;

    IF v_evidence.owner_id != v_req.from_user_id THEN
        RAISE EXCEPTION 'Transfer invalid: Transfer initiator is no longer the current owner of this evidence.';
    END IF;

    IF NOT public.is_user_in_team(v_evidence.team_id, v_caller_id) THEN
        RAISE EXCEPTION 'Transfer rejected: Recipient is no longer an active member of the department team.';
    END IF;

    SELECT display_name INTO v_sender_name
    FROM public.profiles
    WHERE user_id = v_req.from_user_id;

    UPDATE public.transfer_requests
    SET status = 'ACCEPTED',
        responded_at = now(),
        response_notes = 'Transfer accepted by recipient'
    WHERE id = p_request_id;

    -- Atomically reassign evidence ownership (authorized via session flag)
    PERFORM set_config('evidence.allow_status_transferred', 'true', true);
    UPDATE public.evidence
    SET owner_id = v_caller_id,
        assigned_officer_id = v_caller_id,
        updated_at = now()
    WHERE evidence_id = p_evidence_id;

    INSERT INTO public.evidence_custody (
        custody_id,
        evidence_id,
        team_id,
        action,
        performed_by_user_id,
        performed_by,
        role,
        recipient_user_id,
        recipient_name,
        recipient_role,
        notes
    ) VALUES (
        gen_random_uuid()::text,
        v_evidence.id,
        v_req.team_id,
        'EVIDENCE_TRANSFER_ACCEPTED',
        v_caller_id,
        v_recipient_name,
        'OFFICER',
        v_caller_id,
        v_recipient_name,
        'OFFICER',
        format('Transfer accepted from officer %s.', COALESCE(v_sender_name, v_req.from_user_id::text))
    );

    INSERT INTO public.notifications (
        recipient_user_id,
        type,
        title,
        message,
        evidence_id
    ) VALUES (
        v_req.from_user_id,
        'TRANSFER_ACCEPTED',
        'Transfer Accepted',
        format('Your transfer request for evidence %s was accepted by %s.', p_evidence_id, v_recipient_name),
        p_evidence_id
    );

    INSERT INTO public.audit_logs (
        team_id,
        evidence_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description,
        target_user_id,
        target_user_name
    ) VALUES (
        v_req.team_id,
        p_evidence_id,
        v_caller_id,
        v_recipient_name,
        'OFFICER',
        'TRANSFER_ACCEPTED',
        'SUCCESS',
        format('Evidence %s custody transferred to %s', p_evidence_id, v_recipient_name),
        v_req.from_user_id,
        v_sender_name
    );

    RETURN jsonb_build_object('success', true, 'evidence_id', p_evidence_id, 'new_owner_id', v_caller_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION public.reject_custody_transfer(
    p_request_id UUID,
    p_reason TEXT DEFAULT 'Transfer declined by recipient'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    SELECT * INTO v_req
    FROM public.transfer_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer request not found.';
    END IF;

    IF v_req.status != 'PENDING' THEN
        RAISE EXCEPTION 'Transfer request has already been processed.';
    END IF;

    IF v_req.to_user_id != v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: Only the designated recipient can decline this transfer.';
    END IF;

    UPDATE public.transfer_requests
    SET status = 'REJECTED',
        responded_at = now(),
        response_notes = p_reason
    WHERE id = p_request_id;

    INSERT INTO public.notifications (
        recipient_user_id,
        type,
        title,
        message,
        evidence_id
    ) VALUES (
        v_req.from_user_id,
        'TRANSFER_REJECTED',
        'Transfer Declined',
        format('Your transfer request for evidence %s was declined.', v_req.evidence_id),
        v_req.evidence_id
    );

    RETURN jsonb_build_object('success', true, 'request_id', p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.accept_custody_transfer(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_custody_transfer(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_custody_transfer(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_custody_transfer(UUID, TEXT) TO authenticated, service_role;

-- Backward compatibility overload
CREATE OR REPLACE FUNCTION public.accept_custody_transfer(
    p_request_id UUID,
    p_evidence_id TEXT,
    p_recipient_name TEXT
)
RETURNS JSONB AS $$
BEGIN
    RETURN public.accept_custody_transfer(p_request_id, p_evidence_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
GRANT EXECUTE ON FUNCTION public.accept_custody_transfer(UUID, TEXT, TEXT) TO authenticated, service_role;

-- 6.7 Atomic Deletion Approval Procedure
CREATE OR REPLACE FUNCTION public.approve_evidence_deletion(
    p_request_id UUID,
    p_response_notes TEXT DEFAULT 'Approved by department supervisor'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
    v_evidence RECORD;
    v_approver_name TEXT;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    SELECT * INTO v_req
    FROM public.deletion_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion request not found.';
    END IF;

    IF v_req.status != 'PENDING' THEN
        RAISE EXCEPTION 'Deletion request has already been processed (Status: %).', v_req.status;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.teams 
        WHERE id = v_req.team_id 
          AND higher_officer_id = v_caller_id
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only the supervising Higher Officer of this department can approve deletions.';
    END IF;

    IF v_req.requested_by_user_id = v_caller_id THEN
        RAISE EXCEPTION 'Dual-authorization violation: A Higher Officer cannot approve their own deletion request.';
    END IF;

    SELECT display_name INTO v_approver_name FROM public.profiles WHERE user_id = v_caller_id;
    v_approver_name := COALESCE(v_approver_name, 'Higher Officer');

    SELECT * INTO v_evidence
    FROM public.evidence
    WHERE evidence_id = v_req.evidence_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Referenced evidence record not found.';
    END IF;

    UPDATE public.deletion_requests
    SET status = 'APPROVED',
        approved_by_user_id = v_caller_id,
        approved_by_name = v_approver_name,
        responded_at = now(),
        response_notes = p_response_notes
    WHERE id = p_request_id;

    -- Authorize evidence status update via session configuration
    PERFORM set_config('evidence.allow_status_deleted', 'true', true);
    UPDATE public.evidence
    SET status = 'DELETED',
        updated_at = now()
    WHERE id = v_evidence.id;

    INSERT INTO public.evidence_custody (
        custody_id,
        evidence_id,
        team_id,
        action,
        performed_by_user_id,
        performed_by,
        role,
        notes
    ) VALUES (
        gen_random_uuid()::text,
        v_evidence.id,
        v_req.team_id,
        'DELETION_APPROVED',
        v_caller_id,
        v_approver_name,
        'HIGHER_OFFICER',
        format('Evidence deletion approved. Reason: %s. Supervisor notes: %s', v_req.reason, p_response_notes)
    );

    INSERT INTO public.notifications (
        recipient_user_id,
        type,
        title,
        message,
        evidence_id
    ) VALUES (
        v_req.requested_by_user_id,
        'DELETION_APPROVED',
        'Evidence Deletion Approved',
        format('Your deletion request for evidence %s was approved.', v_req.evidence_id),
        v_req.evidence_id
    );

    INSERT INTO public.audit_logs (
        team_id,
        evidence_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description
    ) VALUES (
        v_req.team_id,
        v_req.evidence_id,
        v_caller_id,
        v_approver_name,
        'HIGHER_OFFICER',
        'DELETION_APPROVED',
        'SUCCESS',
        format('Evidence %s marked DELETED by Higher Officer %s', v_req.evidence_id, v_approver_name)
    );

    RETURN jsonb_build_object('success', true, 'evidence_id', v_req.evidence_id, 'status', 'DELETED');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.approve_evidence_deletion(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_evidence_deletion(UUID, TEXT) TO authenticated, service_role;

-- 6.8 Atomic Deletion Rejection Workflow
CREATE OR REPLACE FUNCTION public.reject_evidence_deletion(
    p_request_id UUID,
    p_response_notes TEXT DEFAULT 'Rejected by department supervisor'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
    v_evidence RECORD;
    v_rejecter_name TEXT;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Fetch and lock deletion request
    SELECT * INTO v_req
    FROM public.deletion_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion request not found.';
    END IF;

    IF v_req.status != 'PENDING' THEN
        RAISE EXCEPTION 'Deletion request has already been processed (Status: %).', v_req.status;
    END IF;

    -- Validate caller is the Higher Officer of this team
    IF NOT EXISTS (
        SELECT 1 FROM public.teams 
        WHERE id = v_req.team_id 
          AND higher_officer_id = v_caller_id
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only the supervising Higher Officer of this department can reject deletions.';
    END IF;

    -- Dual authorization rule: Requester cannot act on their own deletion request
    IF v_req.requested_by_user_id = v_caller_id THEN
        RAISE EXCEPTION 'Dual-authorization violation: A Higher Officer cannot review their own deletion request.';
    END IF;

    SELECT display_name INTO v_rejecter_name FROM public.profiles WHERE user_id = v_caller_id;
    v_rejecter_name := COALESCE(v_rejecter_name, 'Higher Officer');

    -- Fetch evidence
    SELECT * INTO v_evidence
    FROM public.evidence
    WHERE evidence_id = v_req.evidence_id;

    -- 1. Mark request REJECTED
    UPDATE public.deletion_requests
    SET status = 'REJECTED',
        approved_by_user_id = v_caller_id,
        approved_by_name = v_rejecter_name,
        responded_at = now(),
        response_notes = p_response_notes
    WHERE id = p_request_id;

    -- 2. Log custody event DELETION_REJECTED (if evidence record exists)
    IF v_evidence.id IS NOT NULL THEN
        INSERT INTO public.evidence_custody (
            custody_id,
            evidence_id,
            team_id,
            action,
            performed_by_user_id,
            performed_by,
            role,
            notes
        ) VALUES (
            gen_random_uuid()::text,
            v_evidence.id,
            v_req.team_id,
            'DELETION_REJECTED',
            v_caller_id,
            v_rejecter_name,
            'HIGHER_OFFICER',
            format('Evidence deletion rejected. Supervisor notes: %s', p_response_notes)
        );
    END IF;

    -- 3. Notify requester
    INSERT INTO public.notifications (
        recipient_user_id,
        type,
        title,
        message,
        evidence_id
    ) VALUES (
        v_req.requested_by_user_id,
        'DELETION_REJECTED',
        'Evidence Deletion Rejected',
        format('Your deletion request for evidence %s was rejected: %s', v_req.evidence_id, p_response_notes),
        v_req.evidence_id
    );

    -- 4. Record compliance audit log
    INSERT INTO public.audit_logs (
        team_id,
        evidence_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description
    ) VALUES (
        v_req.team_id,
        v_req.evidence_id,
        v_caller_id,
        v_rejecter_name,
        'HIGHER_OFFICER',
        'DELETION_REJECTED',
        'SUCCESS',
        format('Deletion request for evidence %s rejected by Higher Officer %s', v_req.evidence_id, v_rejecter_name)
    );

    RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'REJECTED');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.reject_evidence_deletion(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_evidence_deletion(UUID, TEXT) TO authenticated, service_role;

-- ============================================================================
-- 7. STORAGE BUCKET CONFIGURATION & RLS POLICIES
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'evidence-files',
    'evidence-files',
    false,
    52428800, -- 50 MB
    ARRAY[
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'application/pdf'
    ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY[
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'application/pdf'
    ];

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_files_select_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_insert_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_update_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_delete_policy" ON storage.objects;

CREATE POLICY "evidence_files_select_policy"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            -- Primary evidence file access
            (
                public.safe_cast_uuid((storage.foldername(name))[1]) IS NOT NULL
                AND public.safe_cast_uuid((storage.foldername(name))[1]) IN (SELECT public.get_user_team_ids())
                AND (storage.foldername(name))[2] IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM public.evidence e
                    WHERE e.evidence_id = (storage.foldername(name))[2]
                      AND e.team_id = public.safe_cast_uuid((storage.foldername(name))[1])
                      AND e.status != 'DELETED'
                )
            )
            OR
            -- Scoped staging file access
            (
                (storage.foldername(name))[1] = 'staging'
                AND public.safe_cast_uuid((storage.foldername(name))[2]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[2]), auth.uid())
                AND public.safe_cast_uuid((storage.foldername(name))[3]) = auth.uid()
            )
        )
    );

CREATE POLICY "evidence_files_insert_policy"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'evidence-files'
        AND (
            -- Primary evidence attachment upload:
            -- Caller must belong to the specified team, and evidence must exist, belong to that team,
            -- be owned/supervised by caller, and not be marked DELETED.
            (
                public.safe_cast_uuid((storage.foldername(name))[1]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[1]), auth.uid())
                AND (storage.foldername(name))[2] IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM public.evidence e
                    WHERE e.evidence_id = (storage.foldername(name))[2]
                      AND e.team_id = public.safe_cast_uuid((storage.foldername(name))[1])
                      AND (e.owner_id = auth.uid() OR public.is_higher_officer(auth.uid()))
                      AND e.status != 'DELETED'
                )
            )
            OR
            -- Scoped staging upload for offline-first sync (staging/{team_id}/{user_id}/{filename}):
            (
                (storage.foldername(name))[1] = 'staging'
                AND public.safe_cast_uuid((storage.foldername(name))[2]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[2]), auth.uid())
                AND public.safe_cast_uuid((storage.foldername(name))[3]) = auth.uid()
            )
        )
    );

CREATE POLICY "evidence_files_update_policy"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            (
                public.safe_cast_uuid((storage.foldername(name))[1]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[1]), auth.uid())
                AND EXISTS (
                    SELECT 1 FROM public.evidence e
                    WHERE e.evidence_id = (storage.foldername(name))[2]
                      AND e.team_id = public.safe_cast_uuid((storage.foldername(name))[1])
                      AND (e.owner_id = auth.uid() OR public.is_higher_officer(auth.uid()))
                      AND e.status != 'DELETED'
                )
            )
            OR
            (
                (storage.foldername(name))[1] = 'staging'
                AND public.safe_cast_uuid((storage.foldername(name))[2]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[2]), auth.uid())
                AND public.safe_cast_uuid((storage.foldername(name))[3]) = auth.uid()
            )
        )
    )
    WITH CHECK (
        bucket_id = 'evidence-files'
        AND (storage.foldername(name))[1] = (storage.foldername(OLD.name))[1]
        AND (storage.foldername(name))[2] = (storage.foldername(OLD.name))[2]
    );

CREATE POLICY "evidence_files_delete_policy"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            -- Higher Officer deleting files for approved deleted evidence
            (
                public.safe_cast_uuid((storage.foldername(name))[1]) IS NOT NULL
                AND public.is_higher_officer(auth.uid())
                AND EXISTS (
                    SELECT 1 FROM public.teams t 
                    WHERE t.id = public.safe_cast_uuid((storage.foldername(name))[1])
                      AND t.higher_officer_id = auth.uid()
                )
                AND EXISTS (
                    SELECT 1 FROM public.evidence e
                    WHERE e.evidence_id = (storage.foldername(name))[2]
                      AND e.status = 'DELETED'
                )
            )
            OR
            -- Staging file clean-up by the uploader
            (
                (storage.foldername(name))[1] = 'staging'
                AND public.safe_cast_uuid((storage.foldername(name))[2]) IS NOT NULL
                AND public.is_user_in_team(public.safe_cast_uuid((storage.foldername(name))[2]), auth.uid())
                AND public.safe_cast_uuid((storage.foldername(name))[3]) = auth.uid()
            )
        )
    );

-- ============================================================================
-- TEAM OFFICER MANAGEMENT PROCEDURES
-- ============================================================================

-- Add or assign officer to team (bypasses profiles RLS safely, enforces quota & Higher Officer auth)
CREATE OR REPLACE FUNCTION public.add_officer_to_team(
    p_team_id UUID,
    p_email TEXT,
    p_badge_number TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_clean_email TEXT;
    v_clean_badge TEXT;
    v_team RECORD;
    v_target_profile RECORD;
    v_caller_name TEXT;
    v_membership RECORD;
    v_active_count INT;
    v_audit_action TEXT;
    v_audit_desc TEXT;
BEGIN
    -- 1. Parameter validation
    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Team ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_email IS NULL OR TRIM(p_email) = '' THEN
        RAISE EXCEPTION 'Invalid parameter: Email address is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_clean_email := LOWER(TRIM(p_email));
    IF v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'Invalid email format: "%". Please enter a valid email address.', p_email
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_clean_badge := NULLIF(TRIM(p_badge_number), '');

    -- 2. Authentication check
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Caller role verification
    IF public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can add team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Verify supervisory authority over the specified department team & acquire concurrency lock
    SELECT * INTO v_team
    FROM public.teams
    WHERE id = p_team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department team not found (ID: %).', p_team_id
            USING ERRCODE = 'data_exception';
    END IF;

    IF v_team.higher_officer_id IS DISTINCT FROM v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: You do not supervise department team "%" (ID: %).', v_team.name, p_team_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 5. Target officer profile lookup & concurrency row lock
    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE LOWER(email) = v_clean_email
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Officer profile not found for email "%". The officer must register an account first, or create their account using the invite service.', p_email
            USING ERRCODE = 'data_exception';
    END IF;

    -- 6. Role guard: Target must be an ordinary OFFICER
    IF v_target_profile.role != 'OFFICER' THEN
        RAISE EXCEPTION 'Invalid operation: Only users with the ordinary OFFICER role can be added as subordinate team members. Target user role is "%".', v_target_profile.role
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF v_target_profile.user_id = v_caller_id THEN
        RAISE EXCEPTION 'Invalid operation: A Higher Officer cannot add themselves as a subordinate team officer.'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- 7. Cross-team conflict protection: Target officer must not belong to another team
    IF v_target_profile.team_id IS NOT NULL AND v_target_profile.team_id != p_team_id THEN
        RAISE EXCEPTION 'Conflict: Officer "%" is already assigned to another department team. You cannot assign an officer belonging to another team.', v_clean_email
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.team_members
        WHERE user_id = v_target_profile.user_id
          AND team_id != p_team_id
          AND status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Conflict: Officer "%" currently has an active membership in another department team.', v_clean_email
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- 8. Capacity limit check: Count active officers in team
    SELECT COUNT(*) INTO v_active_count
    FROM public.team_members
    WHERE team_id = p_team_id
      AND role = 'OFFICER'
      AND status = 'ACTIVE';

    -- 9. Check existing membership state in this team
    SELECT * INTO v_membership
    FROM public.team_members
    WHERE team_id = p_team_id
      AND user_id = v_target_profile.user_id
    FOR UPDATE;

    -- Case A: Officer is already an active member of this team
    IF FOUND AND v_membership.status = 'ACTIVE' THEN
        -- Safely update badge number if a new one was provided
        IF v_clean_badge IS NOT NULL AND v_clean_badge IS DISTINCT FROM v_target_profile.badge_number THEN
            UPDATE public.profiles
            SET badge_number = v_clean_badge,
                updated_at = now()
            WHERE user_id = v_target_profile.user_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'action', 'ALREADY_ACTIVE',
            'user_id', v_target_profile.user_id,
            'email', v_clean_email,
            'display_name', v_target_profile.display_name,
            'team_id', p_team_id,
            'message', format('Officer %s is already an active member of team %s.', COALESCE(v_target_profile.display_name, v_clean_email), v_team.name)
        );
    END IF;

    -- Ensure capacity limit before adding a new active member
    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Team capacity exceeded: Department team "%" has reached the maximum quota of 5 active officers.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Case B: Officer was previously inactive in this team (Reactivation)
    IF FOUND AND v_membership.status = 'INACTIVE' THEN
        UPDATE public.team_members
        SET status = 'ACTIVE',
            removed_at = NULL,
            joined_at = now()
        WHERE team_id = p_team_id
          AND user_id = v_target_profile.user_id;

        UPDATE public.profiles
        SET team_id = p_team_id,
            badge_number = COALESCE(v_clean_badge, badge_number),
            updated_at = now()
        WHERE user_id = v_target_profile.user_id;

        v_audit_action := 'OFFICER_REACTIVATED';
        v_audit_desc := format('Officer %s (%s) reactivated in team %s', COALESCE(v_target_profile.display_name, v_clean_email), v_clean_email, v_team.name);
    ELSE
        -- Case C: Fresh join
        INSERT INTO public.team_members (team_id, user_id, role, status, joined_at)
        VALUES (p_team_id, v_target_profile.user_id, 'OFFICER', 'ACTIVE', now());

        UPDATE public.profiles
        SET team_id = p_team_id,
            badge_number = COALESCE(v_clean_badge, badge_number),
            updated_at = now()
        WHERE user_id = v_target_profile.user_id;

        v_audit_action := 'OFFICER_ADDED';
        v_audit_desc := format('Officer %s (%s) added to team %s', COALESCE(v_target_profile.display_name, v_clean_email), v_clean_email, v_team.name);
    END IF;

    -- 10. Record immutable audit log
    SELECT display_name INTO v_caller_name FROM public.profiles WHERE user_id = v_caller_id;

    INSERT INTO public.audit_logs (
        team_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description,
        target_user_id,
        target_user_name,
        metadata
    ) VALUES (
        p_team_id,
        v_caller_id,
        COALESCE(v_caller_name, 'Higher Officer'),
        'HIGHER_OFFICER',
        v_audit_action,
        'SUCCESS',
        v_audit_desc,
        v_target_profile.user_id,
        v_target_profile.display_name,
        jsonb_build_object(
            'team_id', p_team_id,
            'team_name', v_team.name,
            'officer_email', v_clean_email,
            'badge_number', COALESCE(v_clean_badge, v_target_profile.badge_number),
            'action_type', v_audit_action
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'action', v_audit_action,
        'user_id', v_target_profile.user_id,
        'email', v_clean_email,
        'display_name', v_target_profile.display_name,
        'team_id', p_team_id,
        'message', v_audit_desc
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.add_officer_to_team(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_officer_to_team(UUID, TEXT, TEXT) TO authenticated, service_role;

-- Deactivate team officer (preserves forensic audit history and evidence ownership)
CREATE OR REPLACE FUNCTION public.deactivate_team_officer(
    p_team_id UUID,
    p_officer_user_id UUID,
    p_reason TEXT DEFAULT 'Deactivated by Higher Officer'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_team RECORD;
    v_target_profile RECORD;
    v_caller_name TEXT;
    v_membership RECORD;
    v_bounded_reason TEXT;
    v_audit_desc TEXT;
BEGIN
    -- 1. Parameter validation
    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Team ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_officer_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Officer user ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_bounded_reason := COALESCE(TRIM(p_reason), 'Deactivated by Higher Officer');
    IF v_bounded_reason = '' THEN
        v_bounded_reason := 'Deactivated by Higher Officer';
    END IF;
    IF LENGTH(v_bounded_reason) > 500 THEN
        v_bounded_reason := SUBSTRING(v_bounded_reason FROM 1 FOR 500);
    END IF;

    -- 2. Authentication check
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Caller role verification
    IF public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can manage team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Verify supervisory authority over team & acquire concurrency lock
    SELECT * INTO v_team
    FROM public.teams
    WHERE id = p_team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department team not found (ID: %).', p_team_id
            USING ERRCODE = 'data_exception';
    END IF;

    IF v_team.higher_officer_id IS DISTINCT FROM v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: You do not supervise department team "%" (ID: %).', v_team.name, p_team_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 5. Prevent supervisor self-deactivation
    IF v_caller_id = p_officer_user_id THEN
        RAISE EXCEPTION 'Invalid operation: A Higher Officer cannot deactivate themselves.'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- 6. Target officer profile lookup & concurrency lock
    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE user_id = p_officer_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target officer profile not found (ID: %).', p_officer_user_id
            USING ERRCODE = 'data_exception';
    END IF;

    -- Prevent deactivation of Higher Officers
    IF v_target_profile.role = 'HIGHER_OFFICER' THEN
        RAISE EXCEPTION 'Invalid operation: Higher Officers cannot be deactivated as team members.'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- 7. Membership lookup & concurrency lock
    SELECT * INTO v_membership
    FROM public.team_members
    WHERE team_id = p_team_id
      AND user_id = p_officer_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Officer % is not a member of team %.', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name
            USING ERRCODE = 'data_exception';
    END IF;

    -- 8. Idempotent check: officer already inactive
    IF v_membership.status = 'INACTIVE' THEN
        -- Ensure profiles.team_id is cleared if it still points to this team
        IF v_target_profile.team_id = p_team_id THEN
            UPDATE public.profiles
            SET team_id = NULL,
                updated_at = now()
            WHERE user_id = p_officer_user_id
              AND team_id = p_team_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'action', 'ALREADY_INACTIVE',
            'user_id', p_officer_user_id,
            'team_id', p_team_id,
            'message', format('Officer %s is already inactive in team %s.', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name)
        );
    END IF;

    -- 9. Deactivate membership in team_members
    UPDATE public.team_members
    SET status = 'INACTIVE',
        removed_at = now()
    WHERE team_id = p_team_id
      AND user_id = p_officer_user_id;

    -- Clear profile team_id ONLY if it references this team
    UPDATE public.profiles
    SET team_id = NULL,
        updated_at = now()
    WHERE user_id = p_officer_user_id
      AND team_id = p_team_id;

    -- 10. Record immutable audit log
    SELECT display_name INTO v_caller_name FROM public.profiles WHERE user_id = v_caller_id;
    v_audit_desc := format('Officer %s deactivated from team %s. Reason: %s', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name, v_bounded_reason);

    INSERT INTO public.audit_logs (
        team_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description,
        target_user_id,
        target_user_name,
        metadata
    ) VALUES (
        p_team_id,
        v_caller_id,
        COALESCE(v_caller_name, 'Higher Officer'),
        'HIGHER_OFFICER',
        'OFFICER_DEACTIVATED',
        'SUCCESS',
        v_audit_desc,
        p_officer_user_id,
        v_target_profile.display_name,
        jsonb_build_object(
            'team_id', p_team_id,
            'team_name', v_team.name,
            'reason', v_bounded_reason,
            'action_type', 'OFFICER_DEACTIVATED'
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'action', 'OFFICER_DEACTIVATED',
        'user_id', p_officer_user_id,
        'team_id', p_team_id,
        'message', v_audit_desc
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.deactivate_team_officer(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_team_officer(UUID, UUID, TEXT) TO authenticated, service_role;

COMMIT;
