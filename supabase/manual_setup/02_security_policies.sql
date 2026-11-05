-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - ROW LEVEL SECURITY (RLS) POLICIES
-- File: 02_security_policies.sql
-- Description: Security helpers, RLS enablement, table access policies, and permission grants.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- ============================================================================
-- 1. SECURE AUTHORIZATION HELPER FUNCTIONS (RECURSION-SAFE & PRIVILEGE-CHECKED)
-- ============================================================================

-- 1.1 Retrieve the authenticated caller's user UUID
CREATE OR REPLACE FUNCTION public.get_auth_user_id()
RETURNS UUID AS $$
    SELECT auth.uid();
$$ LANGUAGE sql STABLE;

-- 1.2 Fetch a user's verified role from profiles
-- Security: Unprivileged users may only query their own role. Only Higher Officers or
-- same-team members may check another user's role.
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

    -- Caller can always check their own role
    IF v_caller_id = v_target_id THEN
        SELECT role INTO v_role
        FROM public.profiles
        WHERE user_id = v_target_id;
        RETURN COALESCE(v_role, 'OFFICER');
    END IF;

    -- Caller checking another user must be a Higher Officer or share an active team
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

    -- Default fallback for unauthorized callers
    RETURN 'OFFICER';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public STABLE;

-- 1.3 Check whether caller is a Higher Officer
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

-- 1.4 Return all active team IDs associated with a user
CREATE OR REPLACE FUNCTION public.get_user_team_ids(p_user_id UUID DEFAULT auth.uid())
RETURNS SETOF UUID AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_target_id UUID := COALESCE(p_user_id, auth.uid());
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN;
    END IF;

    -- Non-supervisors may only query their own team associations
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

-- 1.5 Check whether a user belongs to a specific team
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

-- 1.6 Secure Officer Lookup RPC (Replaces indiscriminate profile scanning)
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

-- 1.7 Secure Team Lookup by Code RPC (Replaces unconditional team table reading)
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

-- Revoke default public execution privileges and grant explicitly to authenticated users
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
-- 2. ENABLE ROW LEVEL SECURITY ON ALL APPLICATION TABLES
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

-- Target-specific policy cleanup (NEVER drops unrelated public schema policies)
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

-- ============================================================================
-- 3. PROFILES POLICIES (NO UNCONDITIONAL ACCESS)
-- ============================================================================

-- Users can only view:
-- 1. Their own profile
-- 2. Profiles of officers in their active teams
-- 3. The Higher Officer supervising their teams
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

-- User registration policy: An ordinary user inserting a profile row can ONLY create
-- an account with role = 'OFFICER'. Self-promotion to HIGHER_OFFICER is rejected.
CREATE POLICY "profiles_insert_policy"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = user_id 
        AND role = 'OFFICER'
    );

-- Users can update their display name and badge number, but CANNOT modify their role or user_id
CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id
        AND role = (SELECT p.role FROM public.profiles p WHERE p.user_id = auth.uid())
        AND user_id = (SELECT p.user_id FROM public.profiles p WHERE p.user_id = auth.uid())
    );

-- ============================================================================
-- 4. TEAMS POLICIES (NO UNCONDITIONAL ACCESS)
-- ============================================================================

-- Users can only view teams they actively belong to or supervise
CREATE POLICY "teams_select_policy"
    ON public.teams FOR SELECT
    TO authenticated
    USING (
        id IN (SELECT public.get_user_team_ids())
    );

-- Only verified Higher Officers can create a team
CREATE POLICY "teams_insert_policy"
    ON public.teams FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() = higher_officer_id 
        AND public.is_higher_officer(auth.uid())
    );

-- Only the supervising Higher Officer can update team information
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

-- ============================================================================
-- 5. TEAM MEMBERS POLICIES (NO ARBITRARY SELF-ENROLLMENT)
-- ============================================================================

-- Team members and higher officers can view their team roster
CREATE POLICY "team_members_select_policy"
    ON public.team_members FOR SELECT
    TO authenticated
    USING (
        team_id IN (SELECT public.get_user_team_ids())
        OR user_id = auth.uid()
    );

-- Only the supervising Higher Officer of the team can add officers
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

-- Only the supervising Higher Officer can update officer status or deactivation
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

-- ============================================================================
-- 6. EVIDENCE POLICIES
-- ============================================================================

-- Active team members can read evidence assigned to their team
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

-- Evidence updates:
-- 1. Owner can update metadata
-- 2. Higher Officer can update verification status
-- Security Controls:
-- - team_id, owner_id, and created_by CANNOT be altered via direct client update
-- - Direct transition to DELETED or TRANSFERRED via client UPDATE is prohibited
--   (DELETED requires approve_evidence_deletion RPC; TRANSFERRED requires accept_custody_transfer RPC)
-- - ARCHIVED status requires Higher Officer supervisory privileges
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

-- Can update upload status / verification metadata; sha256, evidence_id, and file_size are immutable
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

-- NO UPDATE OR DELETE POLICIES: Chain of custody records are immutable.

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

-- Current owner can create a transfer request to another officer in the exact same team
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

-- Recipient can reject/accept; sender can cancel (status must transition from PENDING)
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

-- Active officer on the team can create a deletion request
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

-- Notifications can ONLY be sent to members of the caller's team (prevents spam / cross-team messaging)
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

-- Users can mark only their own notifications as read (cannot alter other fields)
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

-- Authenticated users can enqueue anchor jobs only in PENDING status
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

-- Only backend service_role (Edge Function) can confirm/fail blockchain transactions
-- Clients cannot forge confirmation records or transaction hashes
CREATE POLICY "blockchain_anchors_update_policy"
    ON public.blockchain_anchors FOR UPDATE
    TO authenticated
    USING (
        auth.role() = 'service_role'
    );

-- ============================================================================
-- 13. AUDIT LOGS POLICIES (APPEND-ONLY)
-- ============================================================================

-- Higher Officers can view department audit logs; officers can view logs for their own actions or targets
CREATE POLICY "audit_logs_select_policy"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (
        (team_id IS NOT NULL AND team_id IN (SELECT public.get_user_team_ids()) AND public.is_higher_officer(auth.uid()))
        OR actor_user_id = auth.uid()
        OR target_user_id = auth.uid()
    );

-- Authenticated team members can append audit events for their team or global events
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

-- NO UPDATE OR DELETE POLICIES: Audit logs are legally immutable.
