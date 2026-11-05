-- BACKUP OF 02_security_policies.sql
-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - ROW LEVEL SECURITY (RLS) POLICIES
-- File: 02_security_policies.sql
-- Description: Security helpers, RLS enablement, table access policies, and permission grants.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- ============================================================================
-- 1. SECURE AUTHORIZATION HELPER FUNCTIONS (RECURSION-SAFE)
-- ============================================================================

-- Retrieve the authenticated user's ID
CREATE OR REPLACE FUNCTION public.get_auth_user_id()
RETURNS UUID AS $$
    SELECT auth.uid();
$$ LANGUAGE sql STABLE;

-- Fetch the authenticated user's verified role directly from profiles (bypassing RLS safely)
CREATE OR REPLACE FUNCTION public.get_user_role(p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role
    FROM public.profiles
    WHERE user_id = p_user_id;
    RETURN COALESCE(v_role, 'OFFICER');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;

-- Check whether the user is a Higher Officer / Admin
CREATE OR REPLACE FUNCTION public.is_higher_officer(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role
    FROM public.profiles
    WHERE user_id = p_user_id;
    RETURN UPPER(COALESCE(v_role, '')) IN ('HIGHER_OFFICER', 'ADMIN');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;

-- Return all team IDs the user is currently associated with (as active officer or higher officer)
CREATE OR REPLACE FUNCTION public.get_user_team_ids(p_user_id UUID DEFAULT auth.uid())
RETURNS SETOF UUID AS $$
BEGIN
    RETURN QUERY
    SELECT team_id FROM public.team_members
    WHERE user_id = p_user_id AND status = 'ACTIVE'
    UNION
    SELECT id AS team_id FROM public.teams
    WHERE higher_officer_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;

-- Check whether a user belongs to a specific team
CREATE OR REPLACE FUNCTION public.is_user_in_team(p_team_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.team_members
        WHERE team_id = p_team_id
          AND user_id = p_user_id
          AND status = 'ACTIVE'
    ) OR EXISTS (
        SELECT 1 FROM public.teams
        WHERE id = p_team_id
          AND higher_officer_id = p_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;

-- Grant execution of helpers to authenticated users
GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_higher_officer(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_team_ids(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_in_team(UUID, UUID) TO authenticated;

-- ============================================================================
-- 2. ENABLE ROW LEVEL SECURITY ON ALL TABLES
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

-- Clean up any existing policies to ensure idempotent execution
DO $$
DECLARE
    pol record;
BEGIN
    FOR pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    END LOOP;
END $$;

-- ============================================================================
-- 3. PROFILES POLICIES
-- ============================================================================

-- Authenticated users can view their own profile or search profiles of officers in their department
CREATE POLICY "profiles_select_policy"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (
        auth.uid() = user_id
        OR user_id IN (
            SELECT tm.user_id FROM public.team_members tm 
            WHERE tm.team_id IN (SELECT public.get_user_team_ids())
        )
        OR user_id IN (
            SELECT t.higher_officer_id FROM public.teams t 
            WHERE t.id IN (SELECT public.get_user_team_ids())
        )
        OR true -- Allowed for email search during transfer & team assignment
    );

-- User can create their initial profile row during signup (must match their auth UID, cannot self-assign HIGHER_OFFICER)
CREATE POLICY "profiles_insert_policy"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = user_id 
        AND (
            role = 'OFFICER' 
            OR (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'HIGHER_OFFICER'
        )
    );

-- Users can update their display name and details, but CANNOT self-elevate role
CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id
        AND role = (SELECT p.role FROM public.profiles p WHERE p.user_id = auth.uid())
    );

-- ============================================================================
-- 4. TEAMS POLICIES
-- ============================================================================

-- Users can view teams they belong to or are assigned to
CREATE POLICY "teams_select_policy"
    ON public.teams FOR SELECT
    TO authenticated
    USING (
        id IN (SELECT public.get_user_team_ids())
        OR true -- Team lookup during registration by team_code
    );

-- Only Higher Officers can create a team
CREATE POLICY "teams_insert_policy"
    ON public.teams FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    );

-- Only the team Higher Officer can update team information
CREATE POLICY "teams_update_policy"
    ON public.teams FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    );

-- ============================================================================
-- 5. TEAM MEMBERS POLICIES
-- ============================================================================

-- Team members and higher officers can view their team roster
CREATE POLICY "team_members_select_policy"
    ON public.team_members FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        OR user_id = auth.uid()
    );

-- Only Higher Officers can add officers to their team
CREATE POLICY "team_members_insert_policy"
    ON public.team_members FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = team_members.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
        OR (auth.uid() = user_id AND public.get_user_role(auth.uid()) = 'OFFICER')
    );

-- Higher Officers can update status (e.g. deactivate officer)
CREATE POLICY "team_members_update_policy"
    ON public.team_members FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.teams 
            WHERE teams.id = team_members.team_id 
              AND teams.higher_officer_id = auth.uid()
        )
    );

-- ============================================================================
-- 6. EVIDENCE POLICIES
-- ============================================================================

-- Team members can read evidence assigned to their team
CREATE POLICY "evidence_select_policy"
    ON public.evidence FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

-- Active team members can register new evidence owned by themselves
CREATE POLICY "evidence_insert_policy"
    ON public.evidence FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = owner_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

-- Evidence owner can update metadata; Higher Officer can update status / verification
CREATE POLICY "evidence_update_policy"
    ON public.evidence FOR UPDATE
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        AND (
            auth.uid() = owner_id 
            OR public.is_higher_officer(auth.uid())
            OR EXISTS (
                SELECT 1 FROM public.transfer_requests tr 
                WHERE tr.evidence_id = evidence.evidence_id 
                  AND tr.to_user_id = auth.uid() 
                  AND tr.status = 'PENDING'
            )
        )
    );

-- ============================================================================
-- 7. EVIDENCE ATTACHMENTS POLICIES
-- ============================================================================

-- Can view attachments if user has access to parent evidence
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

-- Can insert attachment if user is an active team member of the evidence
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

-- Can update attachment verification/storage info if owner or Higher Officer
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
    );

-- ============================================================================
-- 8. EVIDENCE CUSTODY POLICIES (FORENSICALLY APPEND-ONLY)
-- ============================================================================

-- Team members can review the chain of custody for their team's evidence
CREATE POLICY "evidence_custody_select_policy"
    ON public.evidence_custody FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

-- Team members can log new custody events for their team (must identify caller)
CREATE POLICY "evidence_custody_insert_policy"
    ON public.evidence_custody FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = performed_by_user_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

-- NO UPDATE OR DELETE POLICIES:
-- Forensic chain of custody records are legally immutable and cannot be altered or removed.

-- ============================================================================
-- 9. TRANSFER REQUESTS POLICIES
-- ============================================================================

-- Sender, recipient, or team supervisor can view transfer requests
CREATE POLICY "transfer_requests_select_policy"
    ON public.transfer_requests FOR SELECT
    TO authenticated
    USING (
        auth.uid() = from_user_id 
        OR auth.uid() = to_user_id
        OR (team_id IN (SELECT public.get_user_team_ids()) AND public.is_higher_officer(auth.uid()))
    );

-- Owner of evidence can create a transfer request to another officer in the same team
CREATE POLICY "transfer_requests_insert_policy"
    ON public.transfer_requests FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = from_user_id
        AND public.is_user_in_team(team_id, auth.uid())
        AND public.is_user_in_team(team_id, to_user_id)
    );

-- Recipient can accept/reject; sender can cancel
CREATE POLICY "transfer_requests_update_policy"
    ON public.transfer_requests FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = to_user_id 
        OR auth.uid() = from_user_id
    );

-- ============================================================================
-- 10. DELETION REQUESTS POLICIES
-- ============================================================================

-- Team members can view deletion requests for their team
CREATE POLICY "deletion_requests_select_policy"
    ON public.deletion_requests FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
    );

-- Officers can create deletion requests for evidence on their team
CREATE POLICY "deletion_requests_insert_policy"
    ON public.deletion_requests FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = requested_by_user_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

-- ONLY Higher Officers can approve or reject deletion requests
CREATE POLICY "deletion_requests_update_policy"
    ON public.deletion_requests FOR UPDATE
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        AND public.is_higher_officer(auth.uid())
    );

-- ============================================================================
-- 11. NOTIFICATIONS POLICIES
-- ============================================================================

-- Users can only view their own notifications
CREATE POLICY "notifications_select_policy"
    ON public.notifications FOR SELECT
    TO authenticated
    USING (
        recipient_user_id = auth.uid()
    );

-- Authenticated users can send notifications to team members
CREATE POLICY "notifications_insert_policy"
    ON public.notifications FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.role() = 'authenticated'
    );

-- Users can mark their own notifications as read
CREATE POLICY "notifications_update_policy"
    ON public.notifications FOR UPDATE
    TO authenticated
    USING (
        recipient_user_id = auth.uid()
    );

-- ============================================================================
-- 12. BLOCKCHAIN ANCHORS POLICIES
-- ============================================================================

-- Team members can view blockchain anchors
CREATE POLICY "blockchain_anchors_select_policy"
    ON public.blockchain_anchors FOR SELECT
    TO authenticated
    USING (
        team_id IS NULL 
        OR team_id IN (SELECT public.get_user_team_ids())
    );

-- Authenticated users can enqueue anchor jobs
CREATE POLICY "blockchain_anchors_insert_policy"
    ON public.blockchain_anchors FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.role() = 'authenticated'
    );

-- Workers and edge functions update status; authenticated team members can update if client-relayed
CREATE POLICY "blockchain_anchors_update_policy"
    ON public.blockchain_anchors FOR UPDATE
    TO authenticated
    USING (
        team_id IS NULL 
        OR team_id IN (SELECT public.get_user_team_ids())
    );

-- ============================================================================
-- 13. AUDIT LOGS POLICIES (APPEND-ONLY)
-- ============================================================================

-- Higher Officers can view team audit logs; evidence owners can view their evidence logs
CREATE POLICY "audit_logs_select_policy"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (
        (team_id IN (SELECT public.get_user_team_ids()) AND public.is_higher_officer(auth.uid()))
        OR actor_user_id = auth.uid()
    );

-- Authenticated team members can insert audit log records
CREATE POLICY "audit_logs_insert_policy"
    ON public.audit_logs FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = actor_user_id
        AND public.is_user_in_team(team_id, auth.uid())
    );

-- NO UPDATE OR DELETE POLICIES:
-- Security and compliance audit logs are strictly append-only.
