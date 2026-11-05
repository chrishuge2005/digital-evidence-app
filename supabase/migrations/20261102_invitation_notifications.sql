-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - MIGRATION
-- Migration: 20261102_invitation_notifications.sql
-- Purpose: In-App Notification & Discovery for Officer Invitations
--          1. Add 'invitation_id' column to public.notifications
--          2. RPC: public.get_my_pending_invitations()
--          3. RPC: public.accept_officer_invitation_by_id(UUID)
--          4. Triggers to create and update in-app notifications automatically
--             when officer_invitations are created, accepted, revoked, or when
--             a new user registers with a pending invitation email.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. EXTEND public.notifications TABLE
-- ============================================================================

-- Add invitation_id column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'notifications' 
          AND column_name = 'invitation_id'
    ) THEN
        ALTER TABLE public.notifications 
            ADD COLUMN invitation_id UUID REFERENCES public.officer_invitations(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Fast index for notifications linked to invitations
CREATE INDEX IF NOT EXISTS idx_notifications_invitation_id 
    ON public.notifications (invitation_id);

-- ============================================================================
-- 2. SECURE DISCOVERY RPC: public.get_my_pending_invitations
-- ============================================================================
-- Returns all active pending invitations for the caller's verified email.
-- Never exposes token_hash or invitations meant for other email addresses.

CREATE OR REPLACE FUNCTION public.get_my_pending_invitations()
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_email TEXT;
    v_invitations JSONB;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Extract caller verified email from JWT claim or profile
    v_caller_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_caller_email = '' THEN
        SELECT LOWER(email) INTO v_caller_email
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    IF v_caller_email IS NULL OR v_caller_email = '' THEN
        RETURN jsonb_build_array();
    END IF;

    -- Query pending invitations matching caller's email
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', i.id,
                'team_id', i.team_id,
                'team_name', t.name,
                'team_code', t.team_code,
                'display_name', i.display_name,
                'email', i.email,
                'invited_by_name', COALESCE(p.display_name, 'Supervising Officer'),
                'status', i.status,
                'expires_at', i.expires_at,
                'created_at', i.created_at
            ) ORDER BY i.created_at DESC
        ),
        jsonb_build_array()
    ) INTO v_invitations
    FROM public.officer_invitations i
    JOIN public.teams t ON t.id = i.team_id
    LEFT JOIN public.profiles p ON p.user_id = i.invited_by
    WHERE LOWER(i.email) = v_caller_email
      AND i.status = 'PENDING'
      AND i.expires_at > NOW();

    RETURN v_invitations;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_my_pending_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_pending_invitations() TO authenticated;

-- ============================================================================
-- 3. IN-APP ACCEPTANCE RPC: public.accept_officer_invitation_by_id
-- ============================================================================
-- Accepts an invitation using the authenticated session and invitation ID.
-- Retrieves the invitation's token_hash internally on the server, then delegates
-- to the hardened public.accept_officer_invitation(token_hash) RPC.
-- Also marks any corresponding in-app notification as read.

CREATE OR REPLACE FUNCTION public.accept_officer_invitation_by_id(
    p_invitation_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_email TEXT;
    v_token_hash TEXT;
    v_result JSONB;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to accept invitation.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_invitation_id IS NULL THEN
        RAISE EXCEPTION 'Invalid parameter: Invitation ID is required.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Extract caller email
    v_caller_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_caller_email = '' THEN
        SELECT LOWER(email) INTO v_caller_email
        FROM public.profiles
        WHERE user_id = v_caller_id;
    END IF;

    -- Lookup invitation
    SELECT token_hash INTO v_token_hash
    FROM public.officer_invitations
    WHERE id = p_invitation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invitation not found.'
            USING ERRCODE = 'data_exception';
    END IF;

    -- Execute existing hardened acceptance function
    v_result := public.accept_officer_invitation(v_token_hash);

    -- Mark related in-app notifications as read
    UPDATE public.notifications
    SET is_read = TRUE
    WHERE invitation_id = p_invitation_id
      AND recipient_user_id = v_caller_id;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.accept_officer_invitation_by_id(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_officer_invitation_by_id(UUID) TO authenticated;

-- ============================================================================
-- 4. AUTOMATIC NOTIFICATION TRIGGERS
-- ============================================================================

-- Function: trg_sync_officer_invitation_notification
-- Dispatches in-app notification when an invitation is created for an existing profile,
-- and updates notifications when accepted or revoked.
CREATE OR REPLACE FUNCTION public.trg_sync_officer_invitation_notification()
RETURNS TRIGGER AS $$
DECLARE
    v_recipient_id UUID;
    v_team_name TEXT;
    v_inviter_name TEXT;
BEGIN
    -- On INSERT of PENDING invitation: Check if user profile already exists
    IF TG_OP = 'INSERT' AND NEW.status = 'PENDING' THEN
        SELECT user_id INTO v_recipient_id
        FROM public.profiles
        WHERE LOWER(email) = LOWER(NEW.email);

        IF v_recipient_id IS NOT NULL THEN
            SELECT name INTO v_team_name FROM public.teams WHERE id = NEW.team_id;
            SELECT display_name INTO v_inviter_name FROM public.profiles WHERE user_id = NEW.invited_by;

            INSERT INTO public.notifications (
                recipient_user_id,
                type,
                title,
                message,
                invitation_id,
                is_read,
                created_at
            ) VALUES (
                v_recipient_id,
                'TEAM_INVITATION',
                'Team Invitation: ' || COALESCE(v_team_name, 'Department Team'),
                COALESCE(v_inviter_name, 'A Higher Officer') || ' has invited you to join ' || COALESCE(v_team_name, 'their department team') || ' as an authorized Officer.',
                NEW.id,
                FALSE,
                NOW()
            );
        END IF;
    END IF;

    -- On UPDATE of status (e.g. ACCEPTED or REVOKED): Mark notification as read
    IF TG_OP = 'UPDATE' AND (NEW.status = 'ACCEPTED' OR NEW.status = 'REVOKED') THEN
        UPDATE public.notifications
        SET is_read = TRUE
        WHERE invitation_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_officer_invitation_notification ON public.officer_invitations;
CREATE TRIGGER trg_officer_invitation_notification
    AFTER INSERT OR UPDATE OF status ON public.officer_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_sync_officer_invitation_notification();

-- Function: trg_on_user_created_sync_pending_invitations
-- When an invited officer registers for the first time, check for any active
-- PENDING invitations matching their email and generate notifications immediately.
CREATE OR REPLACE FUNCTION public.trg_on_user_created_sync_pending_invitations()
RETURNS TRIGGER AS $$
DECLARE
    v_inv RECORD;
    v_team_name TEXT;
    v_inviter_name TEXT;
BEGIN
    FOR v_inv IN
        SELECT id, team_id, invited_by
        FROM public.officer_invitations
        WHERE LOWER(email) = LOWER(NEW.email)
          AND status = 'PENDING'
          AND expires_at > NOW()
    LOOP
        SELECT name INTO v_team_name FROM public.teams WHERE id = v_inv.team_id;
        SELECT display_name INTO v_inviter_name FROM public.profiles WHERE user_id = v_inv.invited_by;

        -- Prevent duplicate notifications
        IF NOT EXISTS (
            SELECT 1 FROM public.notifications 
            WHERE recipient_user_id = NEW.id 
              AND invitation_id = v_inv.id
        ) THEN
            INSERT INTO public.notifications (
                recipient_user_id,
                type,
                title,
                message,
                invitation_id,
                is_read,
                created_at
            ) VALUES (
                NEW.id,
                'TEAM_INVITATION',
                'Team Invitation: ' || COALESCE(v_team_name, 'Department Team'),
                COALESCE(v_inviter_name, 'A Higher Officer') || ' has invited you to join ' || COALESCE(v_team_name, 'their department team') || ' as an authorized Officer.',
                v_inv.id,
                FALSE,
                NOW()
            );
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_invitations_on_profile_created ON public.profiles;
CREATE TRIGGER trg_sync_invitations_on_profile_created
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_on_user_created_sync_pending_invitations();

COMMIT;
