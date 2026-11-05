-- ============================================================================
-- MIGRATION: Fix Evidence Attachments Update RLS Recursion
-- Date: 2026-11-02
--
-- Objective:
-- 1. Eliminate PostgreSQL Error 42P17 (infinite recursion detected in policy for relation "evidence_attachments").
--    The recursive self-referential subqueries:
--    (SELECT ea.evidence_id FROM public.evidence_attachments ea WHERE ea.id = evidence_attachments.id)
--    in the WITH CHECK clause are removed.
-- 2. Preserve all existing authorization requirements:
--    - Authenticated users only
--    - Team boundary enforcement: parent evidence team must be in public.get_user_team_ids()
--    - Evidence owner or Higher Officer authorization: e.owner_id = auth.uid() OR public.is_higher_officer(auth.uid())
-- 3. Provide a dedicated BEFORE UPDATE trigger (trg_validate_attachment_immutability)
--    to unconditionally enforce immutability of evidence_id, attachment_id, sha256, file_size, and created_at.
-- ============================================================================

-- 1. ATTACHMENT IMMUTABILITY TRIGGER FUNCTION
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

-- Ensure trigger is attached to public.evidence_attachments
DROP TRIGGER IF EXISTS trg_validate_attachment_immutability ON public.evidence_attachments;
CREATE TRIGGER trg_validate_attachment_immutability
    BEFORE UPDATE ON public.evidence_attachments
    FOR EACH ROW EXECUTE FUNCTION public.validate_attachment_immutability();

-- 2. REPLACE RECURSIVE EVIDENCE ATTACHMENTS UPDATE POLICY
-- Drop both modern and legacy policy names to guarantee clean state
DROP POLICY IF EXISTS "evidence_attachments_update_policy" ON public.evidence_attachments;
DROP POLICY IF EXISTS "Authenticated users can update attachments" ON public.evidence_attachments;

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

COMMENT ON POLICY "evidence_attachments_update_policy" ON public.evidence_attachments IS 
'Enforces team boundaries and owner or higher officer authorization for evidence attachment updates without recursive subqueries. Immutability of evidence_id, attachment_id, sha256, and file_size is strictly guarded by trg_validate_attachment_immutability.';
