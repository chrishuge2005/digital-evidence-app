-- BACKUP OF 04_storage_policies.sql
-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - STORAGE CONFIGURATION & POLICIES
-- File: 04_storage_policies.sql
-- Description: Private bucket initialization and storage.objects RLS policies.
-- Target Database: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- ============================================================================
-- 1. INITIALIZE PRIVATE STORAGE BUCKET (evidence-files)
-- ============================================================================
-- Evidence files must remain strictly private (public = false).
-- Maximum file size: 50 MB (52,428,800 bytes).
-- Supported MIME types: images, audio, video, and PDF documents.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'evidence-files',
    'evidence-files',
    false,
    52428800, -- 50 MB limit
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
SET public = false,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY[
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'application/pdf'
    ];

-- ============================================================================
-- 2. ENABLE ROW LEVEL SECURITY ON STORAGE OBJECTS
-- ============================================================================
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Clean up any existing policies on evidence-files to prevent duplicate errors
DROP POLICY IF EXISTS "evidence_files_select_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_insert_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_update_policy" ON storage.objects;
DROP POLICY IF EXISTS "evidence_files_delete_policy" ON storage.objects;

-- ============================================================================
-- 3. STORAGE ACCESS POLICIES
-- ============================================================================
-- The application stores files in the hierarchy:
-- {team_id}/{evidence_id}/{attachment_id}
-- Example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/EV-12345/att_abc123.jpg"

-- 3.1 SELECT (Download / View) Policy
-- Authenticated users can view/download evidence files if they belong to the team specified in the path
CREATE POLICY "evidence_files_select_policy"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            -- Team isolation check based on the first path segment
            (storage.foldername(name))[1]::uuid IN (SELECT public.get_user_team_ids())
            OR auth.role() = 'service_role'
        )
    );

-- 3.2 INSERT (Upload) Policy
-- Authenticated users can upload evidence attachments if they belong to the team specified in the path
CREATE POLICY "evidence_files_insert_policy"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'evidence-files'
        AND (
            (storage.foldername(name))[1]::uuid IN (SELECT public.get_user_team_ids())
            OR auth.role() = 'service_role'
        )
    );

-- 3.3 UPDATE Policy
-- Allows updating file metadata within the authorized team path
CREATE POLICY "evidence_files_update_policy"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            (storage.foldername(name))[1]::uuid IN (SELECT public.get_user_team_ids())
            OR auth.role() = 'service_role'
        )
    );

-- 3.4 DELETE Policy
-- Deletions are restricted to team Higher Officers executing approved deletion workflows
CREATE POLICY "evidence_files_delete_policy"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'evidence-files'
        AND (
            (
                (storage.foldername(name))[1]::uuid IN (SELECT public.get_user_team_ids())
                AND public.is_higher_officer(auth.uid())
            )
            OR auth.role() = 'service_role'
        )
    );
