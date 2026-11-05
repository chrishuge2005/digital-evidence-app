-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - MIGRATION
-- Migration: 20261102_officer_invitations.sql
-- Purpose: Secure Officer Invitation & Team Membership System
--          - officer_invitations table with status lifecycle
--          - Cryptographic token hashing (SHA-256)
--          - Strict Row-Level Security (RLS) policies
--          - Atomic invitation acceptance and team assignment RPC
--          - Tamper-proof audit logging integration
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. CREATE DEDICATED TABLE: public.officer_invitations
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.officer_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 2. INDEXES & CONSTRAINTS FOR DATA INTEGRITY
-- ============================================================================

-- Fast lookup by token hash for acceptance
CREATE INDEX IF NOT EXISTS idx_officer_invitations_token_hash 
    ON public.officer_invitations (token_hash);

-- Fast lookup by team_id
CREATE INDEX IF NOT EXISTS idx_officer_invitations_team_id 
    ON public.officer_invitations (team_id);

-- Fast lookup by invitee email (normalized)
CREATE INDEX IF NOT EXISTS idx_officer_invitations_email 
    ON public.officer_invitations (LOWER(email));

-- Fast lookup by status
CREATE INDEX IF NOT EXISTS idx_officer_invitations_status 
    ON public.officer_invitations (status);

-- Prevent duplicate active (PENDING) invitations for the same email within the same team
CREATE UNIQUE INDEX IF NOT EXISTS uq_officer_invitations_team_pending_email
    ON public.officer_invitations (team_id, LOWER(email))
    WHERE (status = 'PENDING');

-- Updated_at trigger for officer_invitations
CREATE OR REPLACE FUNCTION public.trg_officer_invitations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_officer_invitations_updated_at ON public.officer_invitations;
CREATE TRIGGER set_officer_invitations_updated_at
    BEFORE UPDATE ON public.officer_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_officer_invitations_updated_at();

-- ============================================================================
-- 3. ROW LEVEL SECURITY (RLS) FOR officer_invitations
-- ============================================================================

ALTER TABLE public.officer_invitations ENABLE ROW LEVEL SECURITY;

-- Higher Officers can view invitations for teams they supervise
DROP POLICY IF EXISTS "officer_invitations_select_ho" ON public.officer_invitations;
CREATE POLICY "officer_invitations_select_ho"
    ON public.officer_invitations
    FOR SELECT
    TO authenticated
    USING (
        invited_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.id = officer_invitations.team_id
              AND t.higher_officer_id = auth.uid()
        )
    );

-- Invitee can view invitation by email if authenticated
DROP POLICY IF EXISTS "officer_invitations_select_invitee" ON public.officer_invitations;
CREATE POLICY "officer_invitations_select_invitee"
    ON public.officer_invitations
    FOR SELECT
    TO authenticated
    USING (
        LOWER(email) = LOWER(auth.jwt() ->> 'email')
    );

-- Higher Officers can create invitations for teams they supervise
DROP POLICY IF EXISTS "officer_invitations_insert_ho" ON public.officer_invitations;
CREATE POLICY "officer_invitations_insert_ho"
    ON public.officer_invitations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        invited_by = auth.uid()
        AND public.is_higher_officer(auth.uid()) IS TRUE
        AND EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.id = officer_invitations.team_id
              AND t.higher_officer_id = auth.uid()
        )
    );

-- Higher Officers can revoke invitations for their teams
DROP POLICY IF EXISTS "officer_invitations_update_ho" ON public.officer_invitations;
CREATE POLICY "officer_invitations_update_ho"
    ON public.officer_invitations
    FOR UPDATE
    TO authenticated
    USING (
        invited_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.id = officer_invitations.team_id
              AND t.higher_officer_id = auth.uid()
        )
    )
    WITH CHECK (
        status IN ('PENDING', 'REVOKED')
    );

-- ============================================================================
-- 4. FUNCTION: public.create_officer_invitation
-- ============================================================================
-- Allows Higher Officer to securely record an invitation in the database.
-- Validates:
--   1. Caller is authenticated HIGHER_OFFICER.
--   2. Caller supervises the target team.
--   3. Email and name are valid.
--   4. Target is not already an ACTIVE member of this or another team.
--   5. No duplicate PENDING invitation exists (or reuses/updates token).
--   6. Quota: checks active member count on team.

CREATE OR REPLACE FUNCTION public.create_officer_invitation(
    p_team_id UUID,
    p_email TEXT,
    p_display_name TEXT,
    p_token_hash TEXT,
    p_expires_in_days INT DEFAULT 7
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_clean_email TEXT;
    v_clean_name TEXT;
    v_team RECORD;
    v_existing_profile RECORD;
    v_existing_member RECORD;
    v_active_count INT;
    v_invitation_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Parameter Validation
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

    IF p_display_name IS NULL OR TRIM(p_display_name) = '' THEN
        RAISE EXCEPTION 'Invalid parameter: Officer full name is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_clean_name := TRIM(p_display_name);
    IF LENGTH(v_clean_name) > 100 THEN
        RAISE EXCEPTION 'Invalid parameter: Officer name exceeds maximum length of 100 characters.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_token_hash IS NULL OR TRIM(p_token_hash) = '' THEN
        RAISE EXCEPTION 'Invalid parameter: Invitation token hash is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- 2. Authentication Check
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Caller Role Verification (Fail-Closed)
    IF public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can invite team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Verify supervisory authority over team & lock team row
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

    -- 5. Capacity Quota Check (Max 5 active officers)
    SELECT COUNT(*) INTO v_active_count
    FROM public.team_members
    WHERE team_id = p_team_id
      AND status = 'ACTIVE'
      AND role = 'OFFICER';

    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Team capacity exceeded: Department "%" already has % active officers (maximum: 5).', v_team.name, v_active_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- 6. Check existing profile & active memberships
    SELECT * INTO v_existing_profile
    FROM public.profiles
    WHERE LOWER(email) = v_clean_email;

    IF FOUND THEN
        IF v_existing_profile.role = 'HIGHER_OFFICER' THEN
            RAISE EXCEPTION 'Invalid operation: Cannot invite a Higher Officer as an ordinary team member.'
                USING ERRCODE = 'check_violation';
        END IF;

        -- Check if already active in this team
        SELECT * INTO v_existing_member
        FROM public.team_members
        WHERE team_id = p_team_id AND user_id = v_existing_profile.user_id AND status = 'ACTIVE';

        IF FOUND THEN
            RAISE EXCEPTION 'Officer "%" is already an active member of this department team.', v_clean_email
                USING ERRCODE = 'check_violation';
        END IF;

        -- Check if active in any other team
        SELECT * INTO v_existing_member
        FROM public.team_members
        WHERE user_id = v_existing_profile.user_id AND status = 'ACTIVE' AND role = 'OFFICER';

        IF FOUND THEN
            RAISE EXCEPTION 'Conflict: Officer "%" is already an active member of another team. An official transfer is required.', v_clean_email
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- 7. Calculate expiration
    v_expires_at := NOW() + (COALESCE(p_expires_in_days, 7) || ' days')::INTERVAL;

    -- 8. Revoke any existing PENDING invitations for this email in this team
    UPDATE public.officer_invitations
    SET status = 'REVOKED', updated_at = NOW()
    WHERE team_id = p_team_id
      AND LOWER(email) = v_clean_email
      AND status = 'PENDING';

    -- 9. Insert new invitation record
    INSERT INTO public.officer_invitations (
        team_id,
        email,
        display_name,
        invited_by,
        token_hash,
        status,
        expires_at
    ) VALUES (
        p_team_id,
        v_clean_email,
        v_clean_name,
        v_caller_id,
        p_token_hash,
        'PENDING',
        v_expires_at
    )
    RETURNING id INTO v_invitation_id;

    -- 10. Audit Log Entry
    BEGIN
        INSERT INTO public.audit_logs (
            action,
            entity_type,
            entity_id,
            performed_by,
            user_id,
            metadata
        ) VALUES (
            'OFFICER_INVITATION_CREATED',
            'officer_invitations',
            v_invitation_id,
            v_clean_name,
            v_caller_id,
            jsonb_build_object(
                'team_id', p_team_id,
                'team_name', v_team.name,
                'invited_email', v_clean_email,
                'invited_by', v_caller_id,
                'expires_at', v_expires_at
            )
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'invitation_id', v_invitation_id,
        'team_id', p_team_id,
        'team_name', v_team.name,
        'email', v_clean_email,
        'display_name', v_clean_name,
        'expires_at', v_expires_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.create_officer_invitation(UUID, TEXT, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_officer_invitation(UUID, TEXT, TEXT, TEXT, INT) TO authenticated;

-- ============================================================================
-- 5. FUNCTION: public.accept_officer_invitation
-- ============================================================================
-- Consumes an invitation token and links the authenticated officer to the team.
-- Validates:
--   1. Caller is authenticated.
--   2. Token matches a PENDING invitation and is not expired.
--   3. Authenticated user's verified email matches the invitation email.
--   4. Target team exists and quota is not exceeded.
--   5. Officer does not have another active membership.
--   6. Atomically: creates/reactivates team_members row, updates profile, and marks invitation ACCEPTED.

CREATE OR REPLACE FUNCTION public.accept_officer_invitation(
    p_token_hash TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_email TEXT;
    v_invitation RECORD;
    v_team RECORD;
    v_profile RECORD;
    v_existing_member RECORD;
    v_active_count INT;
BEGIN
    -- 1. Authentication Check
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to accept invitation.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Extract caller email from JWT claim or profile
    v_caller_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_caller_email = '' THEN
        SELECT LOWER(email) INTO v_caller_email
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    IF v_caller_email IS NULL OR v_caller_email = '' THEN
        RAISE EXCEPTION 'Cannot verify authenticated account email.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Lookup and Lock Invitation Record
    IF p_token_hash IS NULL OR TRIM(p_token_hash) = '' THEN
        RAISE EXCEPTION 'Invitation token is missing or invalid.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_invitation
    FROM public.officer_invitations
    WHERE token_hash = p_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or unrecognized invitation token.'
            USING ERRCODE = 'data_exception';
    END IF;

    -- 3. Check Invitation Status
    IF v_invitation.status = 'ACCEPTED' THEN
        RAISE EXCEPTION 'This invitation has already been accepted.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_invitation.status = 'REVOKED' THEN
        RAISE EXCEPTION 'This invitation has been revoked by the department supervisor.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_invitation.status = 'EXPIRED' OR v_invitation.expires_at < NOW() THEN
        -- Mark as expired if not already marked
        UPDATE public.officer_invitations SET status = 'EXPIRED', updated_at = NOW() WHERE id = v_invitation.id;
        RAISE EXCEPTION 'This invitation has expired. Please request a new invitation from your supervising Higher Officer.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 4. Identity Check: Authenticated User Email Must Match Invitation Email
    IF LOWER(v_invitation.email) IS DISTINCT FROM v_caller_email THEN
        RAISE EXCEPTION 'Account mismatch: This invitation was issued for "%", but you are signed in as "%". Please sign in with the invited email address to accept.',
            v_invitation.email, v_caller_email
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 5. Lock Target Team & Verify Existence
    SELECT * INTO v_team
    FROM public.teams
    WHERE id = v_invitation.team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The department team associated with this invitation no longer exists.'
            USING ERRCODE = 'data_exception';
    END IF;

    -- 6. Quota Enforcement: Verify Team Has Not Exceeded 5 Active Officers
    SELECT COUNT(*) INTO v_active_count
    FROM public.team_members
    WHERE team_id = v_team.id
      AND status = 'ACTIVE'
      AND role = 'OFFICER'
      AND user_id != v_caller_id;

    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Department team "%" has reached maximum active officer capacity (5 officers).', v_team.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- 7. Check for Active Memberships in Other Teams
    SELECT * INTO v_existing_member
    FROM public.team_members
    WHERE user_id = v_caller_id
      AND status = 'ACTIVE'
      AND role = 'OFFICER'
      AND team_id != v_team.id;

    IF FOUND THEN
        RAISE EXCEPTION 'You are already an active officer in another department team. You must be transferred or deactivated from your existing team before joining a new team.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 8. Upsert Profile Information (Do not overwrite higher officer role if impossible, ensure role is OFFICER)
    SELECT * INTO v_profile
    FROM public.profiles
    WHERE user_id = v_caller_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_profile.role = 'HIGHER_OFFICER' THEN
            RAISE EXCEPTION 'A Higher Officer account cannot join a team as an ordinary officer.'
                USING ERRCODE = 'check_violation';
        END IF;

        UPDATE public.profiles
        SET team_id = v_team.id,
            display_name = COALESCE(NULLIF(TRIM(v_profile.display_name), ''), v_invitation.display_name),
            updated_at = NOW()
        WHERE user_id = v_caller_id;
    ELSE
        INSERT INTO public.profiles (
            user_id,
            email,
            display_name,
            role,
            team_id
        ) VALUES (
            v_caller_id,
            v_caller_email,
            v_invitation.display_name,
            'OFFICER',
            v_team.id
        );
    END IF;

    -- 9. Upsert Team Membership Row
    SELECT * INTO v_existing_member
    FROM public.team_members
    WHERE team_id = v_team.id AND user_id = v_caller_id
    FOR UPDATE;

    IF FOUND THEN
        UPDATE public.team_members
        SET status = 'ACTIVE',
            role = 'OFFICER',
            joined_at = NOW()
        WHERE team_id = v_team.id AND user_id = v_caller_id;
    ELSE
        INSERT INTO public.team_members (
            team_id,
            user_id,
            role,
            status,
            joined_at
        ) VALUES (
            v_team.id,
            v_caller_id,
            'OFFICER',
            'ACTIVE',
            NOW()
        );
    END IF;

    -- 10. Mark Invitation as ACCEPTED
    UPDATE public.officer_invitations
    SET status = 'ACCEPTED',
        accepted_by = v_caller_id,
        accepted_at = NOW(),
        updated_at = NOW()
    WHERE id = v_invitation.id;

    -- 11. Audit Log Entry
    BEGIN
        INSERT INTO public.audit_logs (
            action,
            entity_type,
            entity_id,
            performed_by,
            user_id,
            metadata
        ) VALUES (
            'OFFICER_INVITATION_ACCEPTED',
            'officer_invitations',
            v_invitation.id,
            v_invitation.display_name,
            v_caller_id,
            jsonb_build_object(
                'team_id', v_team.id,
                'team_name', v_team.name,
                'invited_by', v_invitation.invited_by,
                'accepted_by', v_caller_id,
                'email', v_caller_email
            )
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Invitation accepted. You are now an active member of ' || v_team.name || '.',
        'team_id', v_team.id,
        'team_name', v_team.name,
        'user_id', v_caller_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.accept_officer_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_officer_invitation(TEXT) TO authenticated;

-- ============================================================================
-- 6. FUNCTION: public.get_invitation_details
-- ============================================================================
-- Allows client to safely inspect public invitation metadata (team name, inviter, email)
-- given a raw token hash WITHOUT requiring authentication first (for the invite landing screen).

CREATE OR REPLACE FUNCTION public.get_invitation_details(
    p_token_hash TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_inv RECORD;
    v_team RECORD;
    v_inviter RECORD;
BEGIN
    IF p_token_hash IS NULL OR TRIM(p_token_hash) = '' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Token is required.');
    END IF;

    SELECT * INTO v_inv
    FROM public.officer_invitations
    WHERE token_hash = p_token_hash;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Invitation not found.');
    END IF;

    IF v_inv.status = 'ACCEPTED' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Invitation already accepted.');
    END IF;

    IF v_inv.status = 'REVOKED' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Invitation has been revoked.');
    END IF;

    IF v_inv.status = 'EXPIRED' OR v_inv.expires_at < NOW() THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Invitation has expired.');
    END IF;

    SELECT name, team_code INTO v_team
    FROM public.teams
    WHERE id = v_inv.team_id;

    SELECT display_name, email INTO v_inviter
    FROM public.profiles
    WHERE user_id = v_inv.invited_by;

    RETURN jsonb_build_object(
        'valid', true,
        'email', v_inv.email,
        'display_name', v_inv.display_name,
        'team_name', COALESCE(v_team.name, 'Department Team'),
        'team_code', COALESCE(v_team.team_code, ''),
        'invited_by_name', COALESCE(v_inviter.display_name, 'Supervising Officer'),
        'expires_at', v_inv.expires_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_invitation_details(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invitation_details(TEXT) TO anon, authenticated;

COMMIT;
