-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - SUPABASE SCHEMA MIGRATION
-- Project: THE BLOCKCHAIN-BASED DIGITAL EVIDENCE MANAGEMENT SYSTEM
-- Created: 2026-11-01
-- ============================================================================

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Profiles Table
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

-- 3. Teams Table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    team_code TEXT NOT NULL UNIQUE,
    higher_officer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Foreign key link back to profiles
ALTER TABLE public.profiles 
    DROP CONSTRAINT IF EXISTS fk_profiles_team,
    ADD CONSTRAINT fk_profiles_team FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

-- 4. Team Members Table (supports team rosters and max-officer quota)
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

-- 5. Evidence Table
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
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    verification_status TEXT NOT NULL DEFAULT 'PENDING',
    cloud_verification_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Evidence Attachments Table
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
    upload_status TEXT NOT NULL DEFAULT 'PENDING',
    cloud_verification_status TEXT NOT NULL DEFAULT 'NOT_VERIFIED',
    cloud_last_verified_hash TEXT,
    cloud_last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. Evidence Custody Events Table
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

-- 8. Transfer Requests Table
CREATE TABLE IF NOT EXISTS public.transfer_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL,
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    response_notes TEXT
);

-- 9. Deletion Requests Table
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
    responded_at TIMESTAMPTZ,
    response_notes TEXT
);

-- 10. Notifications Table
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

-- 11. Blockchain Anchors Table
CREATE TABLE IF NOT EXISTS public.blockchain_anchors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL,
    team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    anchor_type TEXT NOT NULL DEFAULT 'EVIDENCE',
    reference_id TEXT,
    data_hash TEXT NOT NULL,
    blockchain_network TEXT DEFAULT 'evm_network',
    chain_id TEXT DEFAULT '31337',
    contract_address TEXT,
    transaction_hash TEXT,
    block_number BIGINT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ
);

-- 12. Audit Logs Table
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
-- 13. INDEXES FOR PERFORMANCE
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_teams_higher_officer ON public.teams(higher_officer_id);
CREATE INDEX IF NOT EXISTS idx_teams_code ON public.teams(team_code);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_evidence_team ON public.evidence(team_id);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON public.evidence(owner_id);
CREATE INDEX IF NOT EXISTS idx_evidence_created_by ON public.evidence(created_by);
CREATE INDEX IF NOT EXISTS idx_evidence_attachments_ev ON public.evidence_attachments(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_custody_ev ON public.evidence_custody(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_custody_team ON public.evidence_custody(team_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_team ON public.transfer_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON public.transfer_requests(status);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_team ON public.deletion_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON public.notifications(recipient_user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_blockchain_anchors_status ON public.blockchain_anchors(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_team ON public.audit_logs(team_id, created_at DESC);

-- ============================================================================
-- 14. AUTH USER AUTOMATIC PROFILE CREATION TRIGGER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    assigned_role TEXT;
    user_name TEXT;
BEGIN
    assigned_role := COALESCE(NEW.raw_user_meta_data->>'role', 'OFFICER');
    user_name := COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1));
    
    INSERT INTO public.profiles (user_id, email, display_name, role)
    VALUES (NEW.id, NEW.email, user_name, assigned_role)
    ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.profiles.display_name),
        updated_at = now();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 15. PRIVATE STORAGE BUCKET CONFIGURATION
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'evidence-files',
    'evidence-files',
    false,
    52428800, -- 50 MB
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 52428800;

-- ============================================================================
-- 16. ROW LEVEL SECURITY (RLS) POLICIES
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

-- Profiles: Users can view profiles and edit their own profile
CREATE POLICY "Authenticated users can view profiles"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can insert their own profile"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

-- Teams: Authenticated users can view and create teams
CREATE POLICY "Authenticated users can view teams"
    ON public.teams FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Higher officers can create teams"
    ON public.teams FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = higher_officer_id);

CREATE POLICY "Higher officers can update their own teams"
    ON public.teams FOR UPDATE
    TO authenticated
    USING (auth.uid() = higher_officer_id);

-- Team Members: Authenticated users can view and join teams
CREATE POLICY "Authenticated users can view team members"
    ON public.team_members FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can add team members"
    ON public.team_members FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Higher officers can update team members"
    ON public.team_members FOR UPDATE
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.teams 
        WHERE teams.id = team_members.team_id 
          AND teams.higher_officer_id = auth.uid()
    ));

-- Evidence: Officers and Higher Officers can view evidence for their team
CREATE POLICY "Team members can view team evidence"
    ON public.evidence FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.team_members 
            WHERE team_members.team_id = evidence.team_id 
              AND team_members.user_id = auth.uid() 
              AND team_members.status = 'ACTIVE'
        ) OR EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = evidence.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
    );

CREATE POLICY "Officers can insert evidence"
    ON public.evidence FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Owners and Supervisors can update evidence"
    ON public.evidence FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = owner_id 
        OR EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = evidence.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
    );

-- Evidence Attachments: Team members can access attachments
CREATE POLICY "Team members can view attachments"
    ON public.evidence_attachments FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.evidence 
            WHERE evidence.id = evidence_attachments.evidence_id
        )
    );

CREATE POLICY "Authenticated users can insert attachments"
    ON public.evidence_attachments FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Authenticated users can update attachments"
    ON public.evidence_attachments FOR UPDATE
    TO authenticated
    USING (true);

-- Evidence Custody: Team members can view and insert custody logs
CREATE POLICY "Team members can view custody logs"
    ON public.evidence_custody FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can record custody logs"
    ON public.evidence_custody FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = performed_by_user_id);

-- Transfer Requests: Involvers can view and act on transfer requests
CREATE POLICY "Users can view their transfer requests"
    ON public.transfer_requests FOR SELECT
    TO authenticated
    USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

CREATE POLICY "Officers can create transfer requests"
    ON public.transfer_requests FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = from_user_id);

CREATE POLICY "Recipients can update transfer requests"
    ON public.transfer_requests FOR UPDATE
    TO authenticated
    USING (auth.uid() = to_user_id OR auth.uid() = from_user_id);

-- Deletion Requests
CREATE POLICY "Team members can view deletion requests"
    ON public.deletion_requests FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.team_members 
            WHERE team_members.team_id = deletion_requests.team_id 
              AND team_members.user_id = auth.uid()
        ) OR EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = deletion_requests.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
    );

CREATE POLICY "Officers can create deletion requests"
    ON public.deletion_requests FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = requested_by_user_id);

CREATE POLICY "Higher officers can update deletion requests"
    ON public.deletion_requests FOR UPDATE
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.teams 
        WHERE teams.id = deletion_requests.team_id 
          AND teams.higher_officer_id = auth.uid()
    ));

-- Notifications: Users can only see their own notifications
CREATE POLICY "Users can view their own notifications"
    ON public.notifications FOR SELECT
    TO authenticated
    USING (auth.uid() = recipient_user_id);

CREATE POLICY "Authenticated users can insert notifications"
    ON public.notifications FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Users can update their own notifications"
    ON public.notifications FOR UPDATE
    TO authenticated
    USING (auth.uid() = recipient_user_id);

-- Blockchain Anchors: Read accessible to team members; inserts by authenticated users
CREATE POLICY "Team members can view blockchain anchors"
    ON public.blockchain_anchors FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can queue blockchain anchors"
    ON public.blockchain_anchors FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Service workers can update blockchain anchors"
    ON public.blockchain_anchors FOR UPDATE
    TO authenticated
    USING (true);

-- Audit Logs: Team members can view; users can log actions
CREATE POLICY "Team members can view audit logs"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can record audit logs"
    ON public.audit_logs FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = actor_user_id);

-- ============================================================================
-- 17. STORAGE POLICIES (evidence-files bucket)
-- ============================================================================
CREATE POLICY "Authenticated users can upload evidence files"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'evidence-files');

CREATE POLICY "Authenticated users can view evidence files"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'evidence-files');

CREATE POLICY "Authenticated users can delete evidence files"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'evidence-files');
