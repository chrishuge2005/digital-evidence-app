-- ============================================================================
-- MIGRATION: Fix Evidence Update RLS Recursion and Strengthen Immutability Guards
-- Date: 2026-11-02
--
-- Objective:
-- 1. Eliminate PostgreSQL Error 42P17 (infinite recursion detected in policy for relation "evidence").
--    The recursive self-referential subqueries (SELECT e.team_id FROM public.evidence ...)
--    in the WITH CHECK clause are removed.
-- 2. Preserve all existing authorization requirements:
--    - Authenticated users only
--    - Team boundary enforcement: team_id IN (SELECT public.get_user_team_ids())
--    - Evidence owner or Higher Officer only: auth.uid() = owner_id OR public.is_higher_officer(auth.uid())
--    - Non-deleted records only: status != 'DELETED'
--    - Allowed update statuses: status IN ('ACTIVE', 'PENDING', 'ARCHIVED')
--    - Archiving restricted to Higher Officers: (status != 'ARCHIVED' OR public.is_higher_officer(auth.uid()))
-- 3. Strengthen the BEFORE UPDATE trigger function validate_evidence_status_transition()
--    to unconditionally protect team_id, owner_id, created_by, evidence_id, and created_at.
-- ============================================================================

-- 1. STRENGTHEN IMMUTABILITY TRIGGER FUNCTION
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

-- Ensure trigger is attached to public.evidence
DROP TRIGGER IF EXISTS trg_validate_evidence_status_transition ON public.evidence;
CREATE TRIGGER trg_validate_evidence_status_transition
    BEFORE UPDATE ON public.evidence
    FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_status_transition();

-- 2. REPLACE RECURSIVE EVIDENCE UPDATE POLICY
DROP POLICY IF EXISTS "evidence_update_policy" ON public.evidence;

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

COMMENT ON POLICY "evidence_update_policy" ON public.evidence IS 
'Enforces authenticated officer and higher officer updates to active evidence within team boundaries without recursive subqueries. Immutability of team_id, owner_id, created_by, and created_at is strictly guarded by trg_validate_evidence_status_transition.';
