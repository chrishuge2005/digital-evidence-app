-- BACKUP OF 03_functions_triggers.sql
-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - FUNCTIONS & TRIGGERS
-- File: 03_functions_triggers.sql
-- Description: Business integrity triggers, timestamp automation, and atomic operations.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- ============================================================================
-- 1. AUTOMATIC TIMESTAMP MAINTENANCE (updated_at)
-- ============================================================================
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

DROP TRIGGER IF EXISTS trg_attachments_updated_at ON public.evidence_attachments;
CREATE TRIGGER trg_attachments_updated_at
    BEFORE UPDATE ON public.evidence_attachments
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- 2. AUTH USER PROFILE SYNCHRONIZATION TRIGGER
-- ============================================================================
-- Automatically provisions a profile row when a new user registers in Supabase Auth.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_role TEXT;
    v_name TEXT;
BEGIN
    -- Extract desired role from metadata or default to OFFICER
    v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'OFFICER');
    IF v_role NOT IN ('OFFICER', 'HIGHER_OFFICER') THEN
        v_role := 'OFFICER';
    END IF;

    -- Extract display name or derive from email prefix
    v_name := COALESCE(
        NEW.raw_user_meta_data->>'display_name',
        NEW.raw_user_meta_data->>'full_name',
        split_part(NEW.email, '@', 1)
    );

    INSERT INTO public.profiles (user_id, email, display_name, role)
    VALUES (NEW.id, NEW.email, v_name, v_role)
    ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = COALESCE(public.profiles.display_name, EXCLUDED.display_name),
        updated_at = now();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 3. TEAM OFFICER CAPACITY QUOTA ENFORCEMENT (MAX 5 OFFICERS PER TEAM)
-- ============================================================================
-- Fixes Finding SEC-02: Enforces maximum 5 active officers per Higher Officer team at the database level.
CREATE OR REPLACE FUNCTION public.enforce_team_officer_limit()
RETURNS TRIGGER AS $$
DECLARE
    v_officer_count INTEGER;
BEGIN
    IF NEW.role = 'OFFICER' AND NEW.status = 'ACTIVE' THEN
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
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_enforce_team_officer_limit ON public.team_members;
CREATE TRIGGER trg_enforce_team_officer_limit
    BEFORE INSERT OR UPDATE ON public.team_members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_team_officer_limit();

-- ============================================================================
-- 4. FORENSIC CHAIN OF CUSTODY IMMUTABILITY ENFORCEMENT
-- ============================================================================
-- Guarantees that custody events cannot be updated or deleted under any circumstances.
CREATE OR REPLACE FUNCTION public.enforce_custody_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Forensic violation: Chain of custody records are immutable and cannot be updated or deleted.'
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

-- ============================================================================
-- 5. ATOMIC CUSTODY TRANSFER TRANSACTION (RPC)
-- ============================================================================
-- Safely processes acceptance of a transfer request in a single atomic transaction.
CREATE OR REPLACE FUNCTION public.accept_custody_transfer(
    p_request_id UUID,
    p_evidence_id TEXT,
    p_recipient_name TEXT DEFAULT 'Officer'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
    v_evidence RECORD;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- 1. Fetch and lock the transfer request
    SELECT * INTO v_req
    FROM public.transfer_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer request not found.';
    END IF;

    IF v_req.status != 'PENDING' THEN
        RAISE EXCEPTION 'Transfer request has already been processed (Status: %).', v_req.status;
    END IF;

    IF v_req.to_user_id != v_caller_id THEN
        RAISE EXCEPTION 'Unauthorized: Only the designated recipient can accept this transfer.';
    END IF;

    -- 2. Fetch and lock the evidence record
    SELECT * INTO v_evidence
    FROM public.evidence
    WHERE evidence_id = p_evidence_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evidence record not found.';
    END IF;

    -- 3. Mark transfer request ACCEPTED
    UPDATE public.transfer_requests
    SET status = 'ACCEPTED',
        responded_at = now()
    WHERE id = p_request_id;

    -- 4. Update evidence owner and assigned officer
    UPDATE public.evidence
    SET owner_id = v_caller_id,
        assigned_officer_id = v_caller_id,
        updated_at = now()
    WHERE evidence_id = p_evidence_id;

    -- 5. Record custody log
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
        p_recipient_name,
        'OFFICER',
        v_caller_id,
        p_recipient_name,
        'OFFICER',
        'Transfer accepted by designated officer via atomic transaction.'
    );

    -- 6. Notify the previous owner
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
        format('Your transfer of evidence %s was accepted.', p_evidence_id),
        p_evidence_id
    );

    RETURN jsonb_build_object('success', true, 'evidence_id', p_evidence_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.accept_custody_transfer(UUID, TEXT, TEXT) TO authenticated;
