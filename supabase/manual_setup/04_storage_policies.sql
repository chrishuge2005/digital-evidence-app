-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - STORAGE CONFIGURATION & POLICIES
-- File: 04_storage_policies.sql
-- Target: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- IMPORTANT:
-- Do NOT run ALTER TABLE storage.objects.
-- Supabase manages this table and its RLS configuration.
-- This script manages only the application's bucket and policies.

-- ============================================================================
-- 1. INITIALIZE PRIVATE STORAGE BUCKET
-- ============================================================================

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'evidence-files',
    'evidence-files',
    false,
    52428800,
    ARRAY[
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'application/pdf'
    ]
)
ON CONFLICT (id) DO UPDATE
SET
    public = false,
    file_size_limit = 52428800,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================================
-- 2. REMOVE ONLY THIS APPLICATION'S EXISTING STORAGE POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "evidence_files_select_policy"
    ON storage.objects;

DROP POLICY IF EXISTS "evidence_files_insert_policy"
    ON storage.objects;

DROP POLICY IF EXISTS "evidence_files_update_policy"
    ON storage.objects;

DROP POLICY IF EXISTS "evidence_files_delete_policy"
    ON storage.objects;

-- ============================================================================
-- 3. SELECT POLICY
-- Paths:
-- Primary: {team_id}/{evidence_id}/{attachment_id}_{filename}
-- Staging: staging/{team_id}/{user_id}/{filename}
-- ============================================================================

CREATE POLICY "evidence_files_select_policy"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'evidence-files'
    AND (
        -- Primary evidence files
        (
            public.safe_cast_uuid(
                (storage.foldername(name))[1]
            ) IS NOT NULL

            AND public.is_user_in_team(
                public.safe_cast_uuid(
                    (storage.foldername(name))[1]
                ),
                auth.uid()
            )

            AND (storage.foldername(name))[2] IS NOT NULL

            AND EXISTS (
                SELECT 1
                FROM public.evidence e
                WHERE e.evidence_id = (storage.foldername(name))[2]
                  AND e.team_id = public.safe_cast_uuid(
                      (storage.foldername(name))[1]
                  )
                  AND e.status <> 'DELETED'
            )
        )

        OR

        -- Staging files: uploader only
        (
            (storage.foldername(name))[1] = 'staging'

            AND public.safe_cast_uuid(
                (storage.foldername(name))[2]
            ) IS NOT NULL

            AND public.is_user_in_team(
                public.safe_cast_uuid(
                    (storage.foldername(name))[2]
                ),
                auth.uid()
            )

            AND public.safe_cast_uuid(
                (storage.foldername(name))[3]
            ) = auth.uid()
        )
    )
);

-- ============================================================================
-- 4. INSERT POLICY
-- ============================================================================

CREATE POLICY "evidence_files_insert_policy"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'evidence-files'
    AND (
        -- Primary evidence files
        (
            public.safe_cast_uuid(
                (storage.foldername(name))[1]
            ) IS NOT NULL

            AND public.is_user_in_team(
                public.safe_cast_uuid(
                    (storage.foldername(name))[1]
                ),
                auth.uid()
            )

            AND (storage.foldername(name))[2] IS NOT NULL

            AND EXISTS (
                SELECT 1
                FROM public.evidence e
                WHERE e.evidence_id = (storage.foldername(name))[2]
                  AND e.team_id = public.safe_cast_uuid(
                      (storage.foldername(name))[1]
                  )
                  AND (
                      e.owner_id = auth.uid()
                      OR public.is_higher_officer(auth.uid())
                  )
                  AND e.status NOT IN ('DELETED', 'ARCHIVED')
            )
        )

        OR

        -- Staging files: active team member uploading to own staging folder
        (
            (storage.foldername(name))[1] = 'staging'

            AND public.safe_cast_uuid(
                (storage.foldername(name))[2]
            ) IS NOT NULL

            AND public.is_user_in_team(
                public.safe_cast_uuid(
                    (storage.foldername(name))[2]
                ),
                auth.uid()
            )

            AND public.safe_cast_uuid(
                (storage.foldername(name))[3]
            ) = auth.uid()
        )
    )
);

-- ============================================================================
-- 5. UPDATE POLICY
-- INTENTIONALLY NOT CREATED.
--
-- Authenticated users cannot overwrite or move existing storage objects
-- through an UPDATE operation unless a separate, reviewed policy is added.
--
-- Do not use upsert/overwrite for evidence uploads with this configuration.
-- Use unique object paths for new attachments.
-- ============================================================================

-- ============================================================================
-- 6. DELETE POLICY
-- Primary evidence files:
-- Only the supervising Higher Officer may delete files after the evidence
-- has been marked DELETED through the approved workflow.
--
-- Staging files:
-- The original uploader may clean up their own staging files.
-- ============================================================================

CREATE POLICY "evidence_files_delete_policy"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'evidence-files'
    AND (
        -- Approved deletion of primary evidence files
        (
            public.safe_cast_uuid(
                (storage.foldername(name))[1]
            ) IS NOT NULL

            AND public.is_higher_officer(auth.uid())

            AND EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.id = public.safe_cast_uuid(
                    (storage.foldername(name))[1]
                )
                  AND t.higher_officer_id = auth.uid()
            )

            AND EXISTS (
                SELECT 1
                FROM public.evidence e
                WHERE e.evidence_id = (storage.foldername(name))[2]
                  AND e.team_id = public.safe_cast_uuid(
                      (storage.foldername(name))[1]
                  )
                  AND e.status = 'DELETED'
            )
        )

        OR

        -- Staging cleanup by the uploader
        (
            (storage.foldername(name))[1] = 'staging'

            AND public.safe_cast_uuid(
                (storage.foldername(name))[2]
            ) IS NOT NULL

            AND public.is_user_in_team(
                public.safe_cast_uuid(
                    (storage.foldername(name))[2]
                ),
                auth.uid()
            )

            AND public.safe_cast_uuid(
                (storage.foldername(name))[3]
            ) = auth.uid()
        )
    )
);

-- ============================================================================
-- END OF STORAGE CONFIGURATION
-- ============================================================================