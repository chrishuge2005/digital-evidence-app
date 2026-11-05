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

-- ============================================================================
-- 2. AUTH USER PROFILE SYNCHRONIZATION TRIGGER (DEFAULT OFFICER PRIVILEGE)
-- ============================================================================
-- Automatically provisions a profile row when a new user registers in Supabase Auth.
-- Security: Ordinary registration ALWAYS defaults to 'OFFICER'. Users cannot self-elevate
-- to 'HIGHER_OFFICER' via user_metadata during public signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_name TEXT;
BEGIN
    -- Extract display name or derive from email prefix
    v_name := COALESCE(
        NEW.raw_user_meta_data->>'display_name',
        NEW.raw_user_meta_data->>'full_name',
        split_part(NEW.email, '@', 1)
    );

    -- All self-registrations strictly default to OFFICER
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

-- ============================================================================
-- 3. TRUSTED HIGHER OFFICER PROVISIONING RPC
-- ============================================================================
-- Higher Officer privileges may only be granted by an existing Higher Officer or via this trusted procedure.
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

-- ============================================================================
-- 4. TEAM OFFICER CAPACITY QUOTA (CONCURRENCY-SAFE ROW LOCKING)
-- ============================================================================
-- Enforces maximum 5 active officers per Higher Officer team at the database level.
-- Uses `SELECT FOR UPDATE` on the parent team row to prevent concurrent join race conditions.
CREATE OR REPLACE FUNCTION public.enforce_team_officer_limit()
RETURNS TRIGGER AS $$
DECLARE
    v_officer_count INTEGER;
BEGIN
    IF NEW.role = 'OFFICER' AND NEW.status = 'ACTIVE' THEN
        -- Concurrency lock: Serializes all additions to this team
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

-- ============================================================================
-- 5. FORENSIC CHAIN OF CUSTODY IMMUTABILITY ENFORCEMENT
-- ============================================================================
-- Guarantees that custody events cannot be updated or deleted under any circumstances.
CREATE OR REPLACE FUNCTION public.enforce_custody_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Forensic violation: Chain of custody and audit records are legally immutable and cannot be updated or deleted.'
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
-- 6. ATOMIC CUSTODY TRANSFER WORKFLOW (RPC)
-- ============================================================================
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
    -- 1. Validate authentication
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- 2. Fetch recipient verified display name from database (do not trust client payload)
    SELECT display_name INTO v_recipient_name
    FROM public.profiles
    WHERE user_id = v_caller_id;

    v_recipient_name := COALESCE(v_recipient_name, 'Officer');

    -- 3. Fetch and lock transfer request
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

    -- 4. Fetch and lock evidence record
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

    -- 5. Verify caller is an active member of this team
    IF NOT public.is_user_in_team(v_evidence.team_id, v_caller_id) THEN
        RAISE EXCEPTION 'Transfer rejected: Recipient is no longer an active member of the department team.';
    END IF;

    SELECT display_name INTO v_sender_name
    FROM public.profiles
    WHERE user_id = v_req.from_user_id;

    -- 6. Atomically update request status
    UPDATE public.transfer_requests
    SET status = 'ACCEPTED',
        responded_at = now(),
        response_notes = 'Transfer accepted by recipient'
    WHERE id = p_request_id;

    -- 7. Atomically reassign evidence ownership (set session flag to authorize ownership update)
    PERFORM set_config('evidence.allow_status_transferred', 'true', true);
    UPDATE public.evidence
    SET owner_id = v_caller_id,
        assigned_officer_id = v_caller_id,
        updated_at = now()
    WHERE evidence_id = p_evidence_id;

    -- 8. Record immutable chain of custody entries
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

    -- 9. Notify the sender
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

    -- 10. Record compliance audit log
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

-- Rejection procedure for transfer requests
CREATE OR REPLACE FUNCTION public.reject_custody_transfer(
    p_request_id UUID,
    p_reason TEXT DEFAULT 'Transfer declined by recipient'
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_req RECORD;
    v_recipient_name TEXT;
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

    SELECT display_name INTO v_recipient_name FROM public.profiles WHERE user_id = v_caller_id;

    UPDATE public.transfer_requests
    SET status = 'REJECTED',
        responded_at = now(),
        response_notes = p_reason
    WHERE id = p_request_id;

    -- Notify sender
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

-- Backward compatibility overload for existing 3-parameter callers
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

-- ============================================================================
-- 7. ATOMIC DELETION APPROVAL WORKFLOW (RPC)
-- ============================================================================
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
        RAISE EXCEPTION 'Unauthorized: Only the supervising Higher Officer of this department can approve deletions.';
    END IF;

    -- Dual authorization rule: Requester cannot approve their own deletion request
    IF v_req.requested_by_user_id = v_caller_id THEN
        RAISE EXCEPTION 'Dual-authorization violation: A Higher Officer cannot approve their own deletion request.';
    END IF;

    SELECT display_name INTO v_approver_name FROM public.profiles WHERE user_id = v_caller_id;
    v_approver_name := COALESCE(v_approver_name, 'Higher Officer');

    -- Fetch and lock evidence record
    SELECT * INTO v_evidence
    FROM public.evidence
    WHERE evidence_id = v_req.evidence_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Referenced evidence record not found.';
    END IF;

    -- 1. Mark request APPROVED
    UPDATE public.deletion_requests
    SET status = 'APPROVED',
        approved_by_user_id = v_caller_id,
        approved_by_name = v_approver_name,
        responded_at = now(),
        response_notes = p_response_notes
    WHERE id = p_request_id;

    -- 2. Transition evidence status to DELETED (Authorized via session config)
    PERFORM set_config('evidence.allow_status_deleted', 'true', true);
    UPDATE public.evidence
    SET status = 'DELETED',
        updated_at = now()
    WHERE id = v_evidence.id;

    -- 3. Log custody event DELETION_APPROVED
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

    -- 4. Notify requester
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

    -- 5. Record compliance audit log
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

-- ============================================================================
-- 8. ATOMIC DELETION REJECTION WORKFLOW (RPC)
-- ============================================================================
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

    -- 2. Log custody event DELETION_REJECTED (if evidence record still exists)
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
-- 9. TEAM OFFICER MANAGEMENT PROCEDURES
-- ============================================================================

-- 9.1 Add or assign officer to team (bypasses profiles RLS safely, enforces quota & Higher Officer auth)
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
    -- FIX: the "%" placeholder now has its argument (v_team.name)
    IF v_active_count >= 5 THEN
        RAISE EXCEPTION 'Team capacity exceeded: Department team "%" has reached the maximum quota of 5 active officers.', v_team.name
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

-- 9.2 Deactivate team officer (preserves forensic audit history and evidence ownership)
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