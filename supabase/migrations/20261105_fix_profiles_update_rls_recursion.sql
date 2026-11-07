-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - MIGRATION
-- Migration: 20261105_fix_profiles_update_rls_recursion.sql
-- Purpose: 
--   1. Fix PostgreSQL SQLSTATE 42P17 (infinite recursion in public.profiles UPDATE policy).
--   2. Enforce column immutability (role, user_id, id, created_at) via database trigger.
--   3. Enforce strict team_id protection against unauthorized client reassignment.
--   4. Secure trusted promotion and team assignment procedures with transaction-local guards.
-- Target Database: PostgreSQL 15+ (Supabase)
-- Security Model: Fail-closed, zero recursive subqueries, defense-in-depth.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. DROP RECURSIVE PROFILES UPDATE POLICY
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;

-- ----------------------------------------------------------------------------
-- 2. CREATE NON-RECURSIVE PROFILES UPDATE POLICY
-- ----------------------------------------------------------------------------
CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 3. CREATE PROFILE IMMUTABILITY & ROLE INTEGRITY TRIGGER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_profile_immutability()
RETURNS TRIGGER AS $$
DECLARE
    v_caller_auth_role TEXT := NULLIF(TRIM(auth.role()), '');
    v_caller_uid UUID := auth.uid();
    v_is_authorized_role_change BOOLEAN := FALSE;
    v_is_authorized_team_change BOOLEAN := FALSE;
BEGIN
    -- 1. Unconditionally reject any attempt to modify user_id
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Unauthorized modification: Profile user_id is immutable and cannot be changed.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Unconditionally reject any attempt to modify profile primary key id
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Unauthorized modification: Profile id is immutable and cannot be changed.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Validate role modification (Anti-Escalation & Anti-Self-Promotion Guard)
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        -- Case A: Backend administrative service_role
        IF v_caller_auth_role = 'service_role' THEN
            v_is_authorized_role_change := TRUE;

        -- Case B: Direct administrative SQL execution (no auth context)
        ELSIF v_caller_auth_role IS NULL AND v_caller_uid IS NULL THEN
            IF current_setting('app.allow_role_promotion', true) = 'true' THEN
                v_is_authorized_role_change := TRUE;
            END IF;

        -- Case C: Authenticated caller in a trusted promotion procedure
        ELSIF v_caller_auth_role = 'authenticated' AND v_caller_uid IS NOT NULL THEN
            IF current_setting('app.allow_role_promotion', true) = 'true' THEN
                IF public.is_higher_officer(v_caller_uid) IS TRUE THEN
                    IF v_caller_uid != OLD.user_id THEN
                        v_is_authorized_role_change := TRUE;
                    END IF;
                END IF;
            END IF;
        END IF;

        IF NOT v_is_authorized_role_change THEN
            RAISE EXCEPTION 'Unauthorized role modification: User roles cannot be modified directly. Role elevation requires supervisory authorization.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- 4. Validate team_id modification (Anti-Reassignment Guard)
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
        -- Case A: Backend administrative service_role
        IF v_caller_auth_role = 'service_role' THEN
            v_is_authorized_team_change := TRUE;

        -- Case B: Direct administrative SQL execution
        ELSIF v_caller_auth_role IS NULL AND v_caller_uid IS NULL THEN
            IF current_setting('app.allow_team_reassignment', true) = 'true' THEN
                v_is_authorized_team_change := TRUE;
            END IF;

        -- Case C: Authenticated caller workflows
        ELSIF v_caller_auth_role = 'authenticated' AND v_caller_uid IS NOT NULL THEN
            -- Subcase C1: Trusted team assignment procedures
            IF current_setting('app.allow_team_reassignment', true) = 'true' THEN
                v_is_authorized_team_change := TRUE;

            -- Subcase C2: Higher Officer linking their owned department team
            ELSIF NEW.team_id IS NOT NULL AND public.is_higher_officer(v_caller_uid) IS TRUE THEN
                IF EXISTS (
                    SELECT 1 FROM public.teams
                    WHERE id = NEW.team_id AND higher_officer_id = v_caller_uid
                ) THEN
                    v_is_authorized_team_change := TRUE;
                END IF;
            END IF;
        END IF;

        IF NOT v_is_authorized_team_change THEN
            RAISE EXCEPTION 'Unauthorized team reassignment: Ordinary officers cannot modify their team assignment directly. Team assignments require supervisor assignment or official invitation acceptance.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- 5. Preserve immutable created_at
    NEW.created_at := OLD.created_at;

    -- 6. Automatically maintain updated_at
    NEW.updated_at := NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_validate_profile_immutability ON public.profiles;
CREATE TRIGGER trg_validate_profile_immutability
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_profile_immutability();

-- ----------------------------------------------------------------------------
-- 4. HARDEN TRUSTED PROMOTION RPC WITH TRANSACTION-LOCAL AUTHORIZATION
-- ----------------------------------------------------------------------------
-- FIX: caller details are held in scalar variables (not an unassigned RECORD),
-- so the function no longer fails with 'record "v_caller_profile" is not
-- assigned yet' when called by service_role.
CREATE OR REPLACE FUNCTION public.promote_officer_to_higher_officer(p_target_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_found BOOLEAN := FALSE;
    v_caller_name TEXT;
    v_caller_role TEXT;
    v_caller_team_id UUID;
    v_target_profile RECORD;
    v_audit_team_id UUID;
BEGIN
    -- 1. Authentication check
    IF v_caller_id IS NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Reject self-promotion explicitly
    IF v_caller_id IS NOT NULL AND v_caller_id = p_target_user_id THEN
        RAISE EXCEPTION 'Invalid promotion: A Higher Officer cannot promote themselves.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Verify caller authorization (must be existing Higher Officer or service_role)
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        SELECT display_name, role, team_id
          INTO v_caller_name, v_caller_role, v_caller_team_id
        FROM public.profiles
        WHERE user_id = v_caller_id;

        v_caller_found := FOUND;

        IF NOT v_caller_found OR v_caller_role IS DISTINCT FROM 'HIGHER_OFFICER' THEN
            RAISE EXCEPTION 'Unauthorized: Only an existing Higher Officer can grant supervisory privileges.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- 4. Target user validation
    IF p_target_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid target: Target officer user ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- 5. Fetch and lock target officer profile
    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE user_id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target officer profile not found.'
            USING ERRCODE = 'data_exception';
    END IF;

    -- 6. Idempotency check: already Higher Officer
    IF v_target_profile.role = 'HIGHER_OFFICER' THEN
        RETURN jsonb_build_object(
            'success', true,
            'message', 'Officer already has Higher Officer privileges.',
            'promoted_user_id', p_target_user_id
        );
    END IF;

    -- 7. Set transaction-local promotion authorization flag for the immutability trigger
    PERFORM set_config('app.allow_role_promotion', 'true', true);

    -- 8. Perform role elevation
    UPDATE public.profiles
    SET role = 'HIGHER_OFFICER',
        updated_at = NOW()
    WHERE user_id = p_target_user_id;

    -- Defensive reset of the transaction-local flag immediately after operation
    PERFORM set_config('app.allow_role_promotion', 'false', true);

    -- 9. Resolve audit team_id safely
    v_audit_team_id := COALESCE(v_target_profile.team_id, v_caller_team_id);

    -- 10. Record tamper-proof audit log entry
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
        COALESCE(v_caller_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(v_caller_name, 'System Administrator'),
        COALESCE(v_caller_role, 'ADMINISTRATOR'),
        'OFFICER_PROMOTED',
        'SUCCESS',
        format('Officer %s promoted to Higher Officer by %s',
               COALESCE(v_target_profile.display_name, p_target_user_id::text),
               COALESCE(v_caller_name, v_caller_id::text, 'System Administrator')),
        p_target_user_id,
        v_target_profile.display_name,
        jsonb_build_object(
            'previous_role', v_target_profile.role,
            'new_role', 'HIGHER_OFFICER',
            'promoted_by', v_caller_id
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Officer %s successfully promoted to Higher Officer.', COALESCE(v_target_profile.display_name, p_target_user_id::text)),
        'promoted_user_id', p_target_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.promote_officer_to_higher_officer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_officer_to_higher_officer(UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. HARDEN TRUSTED TEAM MEMBER MANAGEMENT RPCS WITH TRANSACTION-LOCAL FLAG
-- ----------------------------------------------------------------------------

-- A. add_officer_to_team
-- FIX: membership lookup result is stored in v_membership_found, because the
-- later SELECT COUNT(*) resets FOUND to TRUE and made every new officer take
-- the "reactivate" branch (UPDATE of 0 rows, no team_members row inserted).
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
    v_membership_found BOOLEAN := FALSE;
    v_active_count INT;
    v_audit_action TEXT;
    v_audit_desc TEXT;
BEGIN
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

    IF v_caller_id IS NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role' AND public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can add team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_team
    FROM public.teams
    WHERE id = p_team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department team not found (ID: %).', p_team_id
            USING ERRCODE = 'data_exception';
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role' AND v_team.higher_officer_id IS DISTINCT FROM v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: You do not supervise department team "%" (ID: %).', v_team.name, p_team_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_caller_id IS NOT NULL THEN
        SELECT display_name INTO v_caller_name
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE LOWER(email) = v_clean_email
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Officer profile not found for email "%". The officer must register an account first.', p_email
            USING ERRCODE = 'data_exception';
    END IF;

    IF v_target_profile.role = 'HIGHER_OFFICER' THEN
        RAISE EXCEPTION 'Invalid assignment: Higher Officers cannot be assigned as ordinary team officers.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_membership
    FROM public.team_members
    WHERE team_id = p_team_id
      AND user_id = v_target_profile.user_id
    FOR UPDATE;

    v_membership_found := FOUND;

    -- If officer is already active, handle optional badge update and return early
    IF v_membership_found AND v_membership.status = 'ACTIVE' THEN
        IF v_clean_badge IS NOT NULL AND v_clean_badge IS DISTINCT FROM v_target_profile.badge_number THEN
            UPDATE public.profiles
            SET badge_number = v_clean_badge,
                updated_at = NOW()
            WHERE user_id = v_target_profile.user_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'message', format('Officer %s is already an active member of %s.', COALESCE(v_target_profile.display_name, v_clean_email), v_team.name),
            'user_id', v_target_profile.user_id,
            'team_id', p_team_id,
            'status', 'ACTIVE'
        );
    END IF;

    -- Validate team quota before any privilege flag activation
    SELECT COUNT(*) INTO v_active_count
    FROM public.team_members
    WHERE team_id = p_team_id
      AND status = 'ACTIVE'
      AND role = 'OFFICER';

    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Team capacity reached: Team "%" already has % active officers (maximum allowed is 5).', v_team.name, v_active_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Set transaction-local team reassignment flag only after all validation checks have passed
    PERFORM set_config('app.allow_team_reassignment', 'true', true);

    IF v_membership_found THEN
        UPDATE public.team_members
        SET status = 'ACTIVE',
            joined_at = NOW()
        WHERE team_id = p_team_id
          AND user_id = v_target_profile.user_id;

        UPDATE public.profiles
        SET team_id = p_team_id,
            badge_number = COALESCE(v_clean_badge, badge_number),
            updated_at = NOW()
        WHERE user_id = v_target_profile.user_id;

        v_audit_action := 'OFFICER_REASSIGNED';
        v_audit_desc := format('Officer %s reactivated in team %s by %s', COALESCE(v_target_profile.display_name, v_clean_email), v_team.name, COALESCE(v_caller_name, 'Higher Officer'));
    ELSE
        INSERT INTO public.team_members (team_id, user_id, role, status, joined_at)
        VALUES (p_team_id, v_target_profile.user_id, 'OFFICER', 'ACTIVE', NOW());

        UPDATE public.profiles
        SET team_id = p_team_id,
            badge_number = COALESCE(v_clean_badge, badge_number),
            updated_at = NOW()
        WHERE user_id = v_target_profile.user_id;

        v_audit_action := 'OFFICER_ADDED';
        v_audit_desc := format('Officer %s assigned to team %s by %s', COALESCE(v_target_profile.display_name, v_clean_email), v_team.name, COALESCE(v_caller_name, 'Higher Officer'));
    END IF;

    -- Defensive reset of the transaction-local flag immediately following profile update
    PERFORM set_config('app.allow_team_reassignment', 'false', true);

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
        COALESCE(v_caller_id, '00000000-0000-0000-0000-000000000000'::uuid),
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
            'badge_number', v_clean_badge
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Officer %s successfully assigned to team %s.', COALESCE(v_target_profile.display_name, v_clean_email), v_team.name),
        'user_id', v_target_profile.user_id,
        'team_id', p_team_id,
        'status', 'ACTIVE'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- B. deactivate_team_officer
CREATE OR REPLACE FUNCTION public.deactivate_team_officer(
    p_team_id UUID,
    p_officer_user_id UUID,
    p_reason TEXT DEFAULT 'Administrative deactivation by Higher Officer'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_team RECORD;
    v_target_profile RECORD;
    v_membership RECORD;
    v_caller_name TEXT;
    v_clean_reason TEXT;
BEGIN
    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Team ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_officer_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Officer User ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_clean_reason := COALESCE(NULLIF(TRIM(p_reason), ''), 'Administrative deactivation by Higher Officer');

    IF v_caller_id IS NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role' AND public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can manage team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_team
    FROM public.teams
    WHERE id = p_team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department team not found (ID: %).', p_team_id
            USING ERRCODE = 'data_exception';
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role' AND v_team.higher_officer_id IS DISTINCT FROM v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: You do not supervise department team "%" (ID: %).', v_team.name, p_team_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_caller_id = p_officer_user_id THEN
        RAISE EXCEPTION 'Invalid operation: Supervisors cannot deactivate themselves from their supervised team.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_caller_id IS NOT NULL THEN
        SELECT display_name INTO v_caller_name
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE user_id = p_officer_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Officer profile not found (User ID: %).', p_officer_user_id
            USING ERRCODE = 'data_exception';
    END IF;

    SELECT * INTO v_membership
    FROM public.team_members
    WHERE team_id = p_team_id
      AND user_id = p_officer_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership not found: Officer is not assigned to team "%".', v_team.name
            USING ERRCODE = 'data_exception';
    END IF;

    IF v_membership.status = 'INACTIVE' THEN
        IF v_target_profile.team_id = p_team_id THEN
            PERFORM set_config('app.allow_team_reassignment', 'true', true);
            UPDATE public.profiles
            SET team_id = NULL,
                updated_at = NOW()
            WHERE user_id = p_officer_user_id
              AND team_id = p_team_id;
            PERFORM set_config('app.allow_team_reassignment', 'false', true);
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'message', format('Officer %s is already inactive in team %s.', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name),
            'user_id', p_officer_user_id,
            'team_id', p_team_id,
            'status', 'INACTIVE'
        );
    END IF;

    UPDATE public.team_members
    SET status = 'INACTIVE'
    WHERE team_id = p_team_id
      AND user_id = p_officer_user_id;

    -- Set transaction-local team reassignment flag for the immutability trigger
    PERFORM set_config('app.allow_team_reassignment', 'true', true);

    UPDATE public.profiles
    SET team_id = NULL,
        updated_at = NOW()
    WHERE user_id = p_officer_user_id
      AND team_id = p_team_id;

    -- Defensive reset of the transaction-local flag immediately after profile update
    PERFORM set_config('app.allow_team_reassignment', 'false', true);

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
        COALESCE(v_caller_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(v_caller_name, 'Higher Officer'),
        'HIGHER_OFFICER',
        'OFFICER_DEACTIVATED',
        'SUCCESS',
        format('Officer %s deactivated from team %s. Reason: %s', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name, v_clean_reason),
        p_officer_user_id,
        v_target_profile.display_name,
        jsonb_build_object(
            'team_id', p_team_id,
            'team_name', v_team.name,
            'reason', v_clean_reason
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Officer %s successfully deactivated from team %s.', COALESCE(v_target_profile.display_name, p_officer_user_id::text), v_team.name),
        'user_id', p_officer_user_id,
        'team_id', p_team_id,
        'status', 'INACTIVE'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- C. accept_officer_invitation
-- FIX: digest() lives in the "extensions" schema on Supabase and is not on the
-- function's search_path, so it is schema-qualified here.
-- FIX (42P13): an existing accept_officer_invitation(text) was created with the
-- parameter name "p_token_hash". CREATE OR REPLACE cannot rename a parameter, so
-- the old function is dropped first. Grants are re-applied at the end of this file.
DROP FUNCTION IF EXISTS public.accept_officer_invitation(TEXT);

CREATE OR REPLACE FUNCTION public.accept_officer_invitation(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_email TEXT;
    v_token_hash TEXT;
    v_invitation RECORD;
    v_team RECORD;
    v_active_count INT;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_token IS NULL OR TRIM(p_token) = '' THEN
        RAISE EXCEPTION 'Invalid token: Invitation token is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_token_hash := encode(extensions.digest(TRIM(p_token), 'sha256'), 'hex');

    SELECT email INTO v_caller_email
    FROM auth.users
    WHERE id = v_caller_id;

    IF v_caller_email IS NULL OR v_caller_email = '' THEN
        SELECT email INTO v_caller_email
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    IF v_caller_email IS NULL OR v_caller_email = '' THEN
        RAISE EXCEPTION 'Cannot verify authenticated account email.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_invitation
    FROM public.officer_invitations
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or expired invitation token.'
            USING ERRCODE = 'data_exception';
    END IF;

    IF v_invitation.status = 'ACCEPTED' THEN
        RAISE EXCEPTION 'Invitation has already been accepted.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_invitation.status = 'REVOKED' THEN
        RAISE EXCEPTION 'Invitation has been revoked by department supervisor.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_invitation.status = 'EXPIRED' OR v_invitation.expires_at < NOW() THEN
        UPDATE public.officer_invitations
        SET status = 'EXPIRED',
            updated_at = NOW()
        WHERE id = v_invitation.id;

        RAISE EXCEPTION 'Invitation has expired.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF LOWER(TRIM(v_caller_email)) != LOWER(TRIM(v_invitation.email)) THEN
        RAISE EXCEPTION 'Email mismatch: This invitation was issued for "%", but current authenticated account is "%".', v_invitation.email, v_caller_email
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_team
    FROM public.teams
    WHERE id = v_invitation.team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department team referenced by invitation no longer exists.'
            USING ERRCODE = 'data_exception';
    END IF;

    SELECT COUNT(*) INTO v_active_count
    FROM public.team_members
    WHERE team_id = v_team.id
      AND status = 'ACTIVE'
      AND role = 'OFFICER'
      AND user_id != v_caller_id;

    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Team capacity reached: Team "%" already has % active officers (maximum 5).', v_team.name, v_active_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Set transaction-local team reassignment flag for the immutability trigger
    PERFORM set_config('app.allow_team_reassignment', 'true', true);

    INSERT INTO public.team_members (team_id, user_id, role, status, joined_at)
    VALUES (v_team.id, v_caller_id, 'OFFICER', 'ACTIVE', NOW())
    ON CONFLICT (team_id, user_id) DO UPDATE
    SET status = 'ACTIVE',
        joined_at = NOW();

    UPDATE public.profiles
    SET team_id = v_team.id,
        display_name = COALESCE(NULLIF(TRIM(display_name), ''), v_invitation.display_name),
        updated_at = NOW()
    WHERE user_id = v_caller_id;

    -- Defensive reset of the transaction-local flag immediately after profile update
    PERFORM set_config('app.allow_team_reassignment', 'false', true);

    UPDATE public.officer_invitations
    SET status = 'ACCEPTED',
        accepted_by = v_caller_id,
        accepted_at = NOW(),
        updated_at = NOW()
    WHERE id = v_invitation.id;

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Invitation accepted. Welcome to %s.', v_team.name),
        'team_id', v_team.id,
        'team_name', v_team.name
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.add_officer_to_team(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_team_officer(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_officer_invitation(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.add_officer_to_team(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_team_officer(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_officer_invitation(TEXT) TO authenticated, service_role;

COMMIT;