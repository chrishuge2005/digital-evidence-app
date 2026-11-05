-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - MIGRATION
-- Migration: 20261101_team_member_management.sql
-- Purpose: Trusted Higher Officer team member management RPCs
--          (add_officer_to_team, deactivate_team_officer) with full validation,
--          concurrency-safe row locking, quota enforcement, and tamper-proof audit logging.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. DATABASE CONSTRAINTS & INTEGRITY INDEXES
-- ============================================================================

-- Enforce at most one active team membership per ordinary officer across all teams
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_active_officer
    ON public.team_members (user_id)
    WHERE (status = 'ACTIVE' AND role = 'OFFICER');

-- Enforce case-insensitive email uniqueness in public.profiles
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_lower_email
    ON public.profiles (LOWER(email));

-- ============================================================================
-- 2. ADD OR ASSIGN OFFICER TO TEAM RPC
-- ============================================================================
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

    -- 3. Caller role verification (Fail-Closed)
    IF public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can add team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Verify supervisory authority over team & acquire concurrency lock (Fail-Closed)
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

-- ============================================================================
-- 2. DEACTIVATE TEAM OFFICER RPC
-- ============================================================================
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

    -- 3. Caller role verification (Fail-Closed)
    IF public.is_higher_officer(v_caller_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Unauthorized: Only Higher Officers can manage team members.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Verify supervisory authority over team & acquire concurrency lock (Fail-Closed)
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