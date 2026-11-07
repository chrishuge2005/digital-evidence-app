-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - ADMINISTRATIVE BOOTSTRAP SCRIPT
-- Script: bootstrap_initial_higher_officer.sql
-- Description: Secure initial provisioning procedure for a fresh database with no Higher Officer.
-- Execution: Run in Supabase SQL Editor with administrative (postgres / superuser) privileges.
-- Security: Requires direct database administration access. Cannot be executed by public/anon clients.
-- ============================================================================

DO $$
DECLARE
    -- Configure initial supervisor email and team details:
    v_admin_email TEXT := 'captain.alpha@police.gov';  -- Replace with target officer's registered email
    v_team_name TEXT := 'Metro Precinct Alpha';
    v_team_code TEXT := 'MP-ALPHA-01';
    
    v_target_user_id UUID;
    v_target_profile RECORD;
    v_team_id UUID;
    v_existing_ho_id UUID;
BEGIN
    -- 1. Locate the user in public.profiles
    SELECT user_id INTO v_target_user_id
    FROM public.profiles
    WHERE LOWER(email) = LOWER(v_admin_email);

    IF v_target_user_id IS NULL THEN
        RAISE EXCEPTION 'Target user with email "%" does not exist in profiles. The user must sign up through Supabase Auth first before bootstrap promotion.', v_admin_email;
    END IF;

    -- 2. Set transaction-local authorization flags for immutability trigger
    PERFORM set_config('app.allow_role_promotion', 'true', true);
    PERFORM set_config('app.allow_team_reassignment', 'true', true);

    -- 3. Elevate user role to HIGHER_OFFICER
    UPDATE public.profiles
    SET role = 'HIGHER_OFFICER',
        updated_at = NOW()
    WHERE user_id = v_target_user_id;

    -- 4. Create or assign department team (Fail-Closed against unauthorized team takeover)
    -- Retrieve both existing team id and higher_officer_id with concurrency row lock
    SELECT id, higher_officer_id INTO v_team_id, v_existing_ho_id
    FROM public.teams
    WHERE team_code = v_team_code
    FOR UPDATE;

    IF v_team_id IS NULL THEN
        -- Team does not exist: create new team with target user as Higher Officer
        INSERT INTO public.teams (name, team_code, higher_officer_id)
        VALUES (v_team_name, v_team_code, v_target_user_id)
        RETURNING id INTO v_team_id;
    ELSIF v_existing_ho_id IS NOT NULL AND v_existing_ho_id != v_target_user_id THEN
        -- Team exists and belongs to another Higher Officer: prevent ownership takeover
        RAISE EXCEPTION 'Security Conflict: Team with code "%" already exists and is owned by another Higher Officer (User ID: %). Bootstrap cannot take over an existing team.',
            v_team_code, v_existing_ho_id
            USING ERRCODE = 'integrity_constraint_violation';
    ELSE
        -- Team exists and either has no owner (NULL) or already belongs to target user: safely link
        UPDATE public.teams
        SET higher_officer_id = v_target_user_id,
            name = COALESCE(v_team_name, name)
        WHERE id = v_team_id;
    END IF;

    -- 5. Link department team to Higher Officer profile
    UPDATE public.profiles
    SET team_id = v_team_id,
        updated_at = NOW()
    WHERE user_id = v_target_user_id;

    -- Defensive reset of transaction-local authorization flags
    PERFORM set_config('app.allow_role_promotion', 'false', true);
    PERFORM set_config('app.allow_team_reassignment', 'false', true);

    -- 6. Record tamper-proof audit log entry
    INSERT INTO public.audit_logs (
        team_id,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        status,
        description,
        target_user_id,
        metadata
    ) VALUES (
        v_team_id,
        v_target_user_id,
        'Initial System Administrator',
        'ADMINISTRATOR',
        'INITIAL_HO_BOOTSTRAP',
        'SUCCESS',
        format('Initial Higher Officer elevated: %s, assigned to team %s (%s)', v_admin_email, v_team_name, v_team_code),
        v_target_user_id,
        jsonb_build_object(
            'bootstrapped_email', v_admin_email,
            'team_id', v_team_id,
            'team_code', v_team_code
        )
    );

    RAISE NOTICE 'SUCCESS: User % (User ID: %) successfully promoted to HIGHER_OFFICER and assigned to team % (Team ID: %).', 
        v_admin_email, v_target_user_id, v_team_name, v_team_id;
END $$;
