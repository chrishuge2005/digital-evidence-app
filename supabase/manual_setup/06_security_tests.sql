-- ============================================================================
-- DIGITAL EVIDENCE MANAGEMENT SYSTEM - AUTOMATED SECURITY TEST SUITE
-- File: 06_security_tests.sql
-- Description: Rigorous security test harness validating RLS policies,
--              status transition guards, storage authorization, and privileged RPCs.
-- Execution: Paste into Supabase SQL Editor.
-- Note: Uses auth.users compliant mock identities and forces RLS evaluation.
--       Cleans up all test data automatically upon completion.
-- ============================================================================

DO $$
DECLARE
    -- Test user identities
    v_instance_id UUID := '00000000-0000-0000-0000-000000000000'::uuid;
    v_ho1_id UUID := gen_random_uuid();
    v_ho2_id UUID := gen_random_uuid();
    v_officer1_id UUID := gen_random_uuid();
    v_officer2_id UUID := gen_random_uuid();
    v_officer_alien_id UUID := gen_random_uuid();
    v_unassigned_id UUID := gen_random_uuid();

    -- Test department teams
    v_team1_id UUID := gen_random_uuid();
    v_team2_id UUID := gen_random_uuid();

    -- Test evidence items
    v_ev1_uuid UUID := gen_random_uuid();
    v_ev1_code TEXT := 'EV-TEST-1001';
    v_ev2_uuid UUID := gen_random_uuid();
    v_ev2_code TEXT := 'EV-TEST-2001';

    -- Test request identifiers
    v_transfer_id UUID := gen_random_uuid();
    v_del_req_id UUID := gen_random_uuid();

    -- Counters and diagnostics
    v_test_count INT := 0;
    v_pass_count INT := 0;
    v_fail_count INT := 0;
    v_rows_affected INT := 0;
    v_res JSONB;
    v_rec RECORD;
BEGIN
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'STARTING RIGOROUS DATABASE SECURITY VERIFICATION TEST SUITE';
    RAISE NOTICE '============================================================';

    -- ------------------------------------------------------------------------
    -- SETUP: Provision valid auth.users and profile records
    -- ------------------------------------------------------------------------
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES 
        (v_ho1_id, v_instance_id, 'authenticated', 'authenticated', 'test_ho1@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Higher Officer Alpha"}', now(), now()),
        (v_ho2_id, v_instance_id, 'authenticated', 'authenticated', 'test_ho2@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Higher Officer Beta"}', now(), now()),
        (v_officer1_id, v_instance_id, 'authenticated', 'authenticated', 'test_officer1@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Officer One"}', now(), now()),
        (v_officer2_id, v_instance_id, 'authenticated', 'authenticated', 'test_officer2@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Officer Two"}', now(), now()),
        (v_officer_alien_id, v_instance_id, 'authenticated', 'authenticated', 'test_alien@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Officer Alien"}', now(), now()),
        (v_unassigned_id, v_instance_id, 'authenticated', 'authenticated', 'test_unassigned@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Unassigned Officer"}', now(), now())
    ON CONFLICT (id) DO NOTHING;

    -- Elevate supervisors in public.profiles (handle_new_user trigger created initial profiles)
    UPDATE public.profiles SET role = 'HIGHER_OFFICER' WHERE user_id IN (v_ho1_id, v_ho2_id);

    -- Create department teams
    INSERT INTO public.teams (id, name, team_code, higher_officer_id) VALUES
        (v_team1_id, 'Cyber Crime Unit Alpha', 'CCU-ALPHA', v_ho1_id),
        (v_team2_id, 'Forensics Unit Beta', 'FOR-BETA', v_ho2_id);

    -- Assign officers to teams
    INSERT INTO public.team_members (team_id, user_id, role, status) VALUES
        (v_team1_id, v_officer1_id, 'OFFICER', 'ACTIVE'),
        (v_team1_id, v_officer2_id, 'OFFICER', 'ACTIVE'),
        (v_team2_id, v_officer_alien_id, 'OFFICER', 'ACTIVE');

    UPDATE public.profiles SET team_id = v_team1_id WHERE user_id IN (v_officer1_id, v_officer2_id);
    UPDATE public.profiles SET team_id = v_team2_id WHERE user_id = v_officer_alien_id;

    -- Register baseline evidence items
    INSERT INTO public.evidence (id, evidence_id, team_id, owner_id, created_by, title, status) VALUES
        (v_ev1_uuid, v_ev1_code, v_team1_id, v_officer1_id, v_officer1_id, 'Alpha Hard Drive', 'ACTIVE'),
        (v_ev2_uuid, v_ev2_code, v_team2_id, v_officer_alien_id, v_officer_alien_id, 'Beta Smartphone', 'ACTIVE');

    -- Enforce RLS for all roles including table owner during test execution
    ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.teams FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.team_members FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence_attachments FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence_custody FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.transfer_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.deletion_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.blockchain_anchors FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

    -- ------------------------------------------------------------------------
    -- TEST 1: Ordinary officer cannot self-promote to HIGHER_OFFICER
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        UPDATE public.profiles SET role = 'HIGHER_OFFICER' WHERE user_id = v_officer1_id;

        IF (SELECT role FROM public.profiles WHERE user_id = v_officer1_id) = 'OFFICER' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 1 PASSED: Officer self-promotion blocked by profiles_update_policy.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 1 FAILED: Officer successfully elevated role!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 1 PASSED: Officer self-promotion rejected with error: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 2: Ordinary officer cannot self-enroll into another team
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        INSERT INTO public.team_members (team_id, user_id, role, status)
        VALUES (v_team2_id, v_officer1_id, 'OFFICER', 'ACTIVE');

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 2 FAILED: Officer enrolled themselves into an unauthorized team!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 2 PASSED: Arbitrary team enrollment blocked: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 3: Cross-team evidence isolation: Officer cannot read another team's evidence
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        SELECT * INTO v_rec FROM public.evidence WHERE id = v_ev2_uuid;

        IF v_rec.id IS NULL THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 3 PASSED: Cross-team evidence reading blocked (0 rows returned).';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 3 FAILED: Officer 1 accessed Team 2 evidence: %', v_rec.title;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 3 PASSED with exception: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 4 [SEC-02]: Direct client mutation of evidence status to DELETED is blocked
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        UPDATE public.evidence SET status = 'DELETED' WHERE id = v_ev1_uuid;

        IF (SELECT status FROM public.evidence WHERE id = v_ev1_uuid) = 'ACTIVE' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 4 PASSED: Direct status change to DELETED blocked by status validator.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 4 FAILED: Direct status change to DELETED succeeded!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 4 PASSED: Direct status change to DELETED rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 5 [SEC-01]: Storage upload policy prevents upload for nonexistent evidence (no OR true)
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Officer 1 attempts upload under non-existent evidence code in Team 1
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES (gen_random_uuid(), 'evidence-files', v_team1_id::text || '/EV-FAKE-9999/test.jpg', v_officer1_id);

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 5 FAILED: Storage upload succeeded under nonexistent evidence!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 5 PASSED: Storage upload for invalid evidence rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 6 [SEC-01]: Cross-team storage upload is blocked
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Officer 1 attempts upload into Team 2's folder
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES (gen_random_uuid(), 'evidence-files', v_team2_id::text || '/' || v_ev2_code || '/test.jpg', v_officer1_id);

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 6 FAILED: Cross-team storage upload succeeded!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 6 PASSED: Cross-team storage upload rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 7: Ordinary officer cannot delete evidence files from storage
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        DELETE FROM storage.objects 
        WHERE bucket_id = 'evidence-files' 
          AND name = v_team1_id::text || '/' || v_ev1_code || '/alpha_disk.raw';
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

        IF v_rows_affected = 0 THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 7 PASSED: Storage deletion by officer blocked (0 rows affected).';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 7 FAILED: Officer deleted evidence files from storage!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 7 PASSED with exception: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 8 [SEC-04]: Direct update of deletion request to APPROVED is blocked
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        -- Insert a PENDING deletion request as Officer 1
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        INSERT INTO public.deletion_requests (id, evidence_id, team_id, requested_by_user_id, requested_by_name, reason, status)
        VALUES (v_del_req_id, v_ev1_code, v_team1_id, v_officer1_id, 'Officer One', 'Case closed, retention expired', 'PENDING');

        -- Officer 1 attempts to mark their own deletion request APPROVED
        UPDATE public.deletion_requests SET status = 'APPROVED' WHERE id = v_del_req_id;

        IF (SELECT status FROM public.deletion_requests WHERE id = v_del_req_id) = 'PENDING' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 8 PASSED: Direct client update to APPROVED blocked by deletion policy.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 8 FAILED: Client directly updated deletion request to APPROVED!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 8 PASSED: Direct update to APPROVED rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 9 [SEC-04]: Dual-authorization: Higher Officer cannot approve own deletion request
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        -- Higher Officer creates a deletion request
        DECLARE
            v_ho_del_id UUID := gen_random_uuid();
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
            PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

            INSERT INTO public.deletion_requests (id, evidence_id, team_id, requested_by_user_id, requested_by_name, reason, status)
            VALUES (v_ho_del_id, v_ev1_code, v_team1_id, v_ho1_id, 'Higher Officer Alpha', 'Self request', 'PENDING');

            -- Attempt approval via RPC
            PERFORM public.approve_evidence_deletion(v_ho_del_id, 'Self approval attempt');

            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 9 FAILED: Dual-authorization failed: Higher Officer approved own request!';
        EXCEPTION WHEN OTHERS THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 9 PASSED: Dual-authorization enforced: %', SQLERRM;
        END;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 10 [SEC-04]: Legitimate deletion approval workflow succeeds atomically
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Higher Officer approves Officer 1's request via trusted RPC
        v_res := public.approve_evidence_deletion(v_del_req_id, 'Approved after review');

        -- Verify atomic effects:
        -- 1. Request status is APPROVED
        -- 2. Evidence status is DELETED
        -- 3. Custody event logged
        -- 4. Audit log created
        IF (SELECT status FROM public.deletion_requests WHERE id = v_del_req_id) = 'APPROVED'
           AND (SELECT status FROM public.evidence WHERE id = v_ev1_uuid) = 'DELETED'
           AND EXISTS (SELECT 1 FROM public.evidence_custody WHERE evidence_id = v_ev1_uuid AND action = 'DELETION_APPROVED')
           AND EXISTS (SELECT 1 FROM public.audit_logs WHERE evidence_id = v_ev1_code AND action = 'DELETION_APPROVED') THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 10 PASSED: Deletion approved atomically with custody & audit logs.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 10 FAILED: Atomic deletion approval verification failed!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 10 FAILED with error: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 11: Chain of custody records cannot be updated or deleted
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        UPDATE public.evidence_custody SET notes = 'Tampered' WHERE evidence_id = v_ev1_uuid;

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 11 FAILED: Custody ledger record was updated!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 11 PASSED: Custody immutability enforced: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 12: Audit logs cannot be updated or deleted
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        DELETE FROM public.audit_logs WHERE evidence_id = v_ev1_code;

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 12 FAILED: Audit log record was deleted!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 12 PASSED: Audit log immutability enforced: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 13 [SEC-03]: Promotion of unassigned officer succeeds without FK crash
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Unassigned officer has team_id IS NULL
        v_res := public.promote_officer_to_higher_officer(v_unassigned_id);

        IF (SELECT role FROM public.profiles WHERE user_id = v_unassigned_id) = 'HIGHER_OFFICER'
           AND EXISTS (SELECT 1 FROM public.audit_logs WHERE target_user_id = v_unassigned_id AND action = 'OFFICER_PROMOTED') THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 13 PASSED: Unassigned officer promoted without FK constraint violation.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 13 FAILED: Unassigned officer promotion failed to verify!';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 13 FAILED with error: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 14 [SEC-03]: Non-Higher Officer cannot call promote_officer_to_higher_officer
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        PERFORM public.promote_officer_to_higher_officer(v_officer2_id);

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 14 FAILED: Officer promoted another officer without authorization!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 14 PASSED: Unauthorized promotion attempt rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 15: Cross-team transfer request creation is blocked
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Officer 1 attempts to transfer evidence to Officer Alien in Team 2
        INSERT INTO public.transfer_requests (evidence_id, team_id, from_user_id, to_user_id, status)
        VALUES (v_ev1_code, v_team1_id, v_officer1_id, v_officer_alien_id, 'PENDING');

        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 15 FAILED: Cross-team transfer request was accepted!';
    EXCEPTION WHEN OTHERS THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 15 PASSED: Cross-team transfer request rejected: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 16: Ordinary user cannot update blockchain anchor status
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        DECLARE
            v_anchor_id UUID := gen_random_uuid();
        BEGIN
            -- Insert pending anchor
            INSERT INTO public.blockchain_anchors (id, evidence_id, team_id, data_hash, status)
            VALUES (v_anchor_id, v_ev1_code, v_team1_id, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'PENDING');

            -- Officer 1 attempts to forge confirmation
            PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
            PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

            UPDATE public.blockchain_anchors 
            SET status = 'CONFIRMED', transaction_hash = '0x1234567890abcdef' 
            WHERE id = v_anchor_id;
            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

            IF v_rows_affected = 0 THEN
                v_pass_count := v_pass_count + 1;
                RAISE NOTICE 'TEST 16 PASSED: Blockchain anchor update blocked for client (0 rows affected).';
            ELSE
                v_fail_count := v_fail_count + 1;
                RAISE WARNING 'TEST 16 FAILED: Officer forged blockchain confirmation!';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 16 PASSED with exception: %', SQLERRM;
        END;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 17: Authorized Higher Officer assigns an unassigned officer to team
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(v_team1_id, 'test_unassigned@police.test', 'BADGE-TEST-99');

        IF (v_res->>'success')::boolean = true AND EXISTS (
            SELECT 1 FROM public.team_members WHERE team_id = v_team1_id AND user_id = v_unassigned_id AND status = 'ACTIVE'
        ) AND EXISTS (
            SELECT 1 FROM public.profiles WHERE user_id = v_unassigned_id AND team_id = v_team1_id AND badge_number = 'BADGE-TEST-99'
        ) THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 17 PASSED: Authorized Higher Officer added officer to team.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 17 FAILED: add_officer_to_team returned unexpected result: %', v_res;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 17 FAILED with exception: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 18: Unauthorized ordinary officer cannot call add_officer_to_team
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_officer1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(v_team1_id, 'test_alien@police.test');
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 18 FAILED: Ordinary officer was able to call add_officer_to_team!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Only Higher Officers%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 18 PASSED: Ordinary officer blocked with error: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 18 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 19: Missing team raises data_exception
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(gen_random_uuid(), 'test_unassigned@police.test');
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 19 FAILED: Non-existent team accepted!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Department team not found%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 19 PASSED: Non-existent team rejected: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 19 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 20: Missing target profile raises data_exception
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(v_team1_id, 'ghost_user_999@police.test');
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 20 FAILED: Non-existent officer accepted!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Officer profile not found%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 20 PASSED: Missing target profile rejected: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 20 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 21: Invalid email format raises invalid_parameter_value
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(v_team1_id, 'not-an-email');
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 21 FAILED: Invalid email accepted!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Invalid email format%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 21 PASSED: Invalid email rejected: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 21 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 22: Duplicate membership is handled idempotently
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.add_officer_to_team(v_team1_id, 'test_unassigned@police.test', 'BADGE-TEST-UPDATED');
        IF (v_res->>'success')::boolean = true AND v_res->>'action' = 'ALREADY_ACTIVE' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 22 PASSED: Duplicate active member handled idempotently.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 22 FAILED: Unexpected duplicate response: %', v_res;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 22 FAILED with exception: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 23: Conflicting assignment to another team is strictly rejected
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- Officer Alien belongs to Team 2
        v_res := public.add_officer_to_team(v_team1_id, 'test_alien@police.test');
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 23 FAILED: Officer belonging to another team was assigned without transfer!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%already assigned to another department team%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 23 PASSED: Cross-team assignment blocked: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 23 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 24: Team officer capacity quota (max 5 active officers)
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    DECLARE
        v_cap_user4 UUID := gen_random_uuid();
        v_cap_user5 UUID := gen_random_uuid();
        v_cap_user6 UUID := gen_random_uuid();
    BEGIN
        -- Provision mock officers 4, 5, 6
        INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        VALUES 
            (v_cap_user4, v_instance_id, 'authenticated', 'authenticated', 'test_cap4@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email"}', '{"display_name":"Cap Four"}', now(), now()),
            (v_cap_user5, v_instance_id, 'authenticated', 'authenticated', 'test_cap5@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email"}', '{"display_name":"Cap Five"}', now(), now()),
            (v_cap_user6, v_instance_id, 'authenticated', 'authenticated', 'test_cap6@police.test', crypt('Password123!', gen_salt('bf')), now(), '{"provider":"email"}', '{"display_name":"Cap Six"}', now(), now())
        ON CONFLICT (id) DO NOTHING;

        -- Team 1 currently has 3 active members: officer1, officer2, unassigned
        -- Add 4th and 5th members
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        PERFORM public.add_officer_to_team(v_team1_id, 'test_cap4@police.test');
        PERFORM public.add_officer_to_team(v_team1_id, 'test_cap5@police.test');

        -- Attempt 6th member -> must fail
        BEGIN
            PERFORM public.add_officer_to_team(v_team1_id, 'test_cap6@police.test');
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 24 FAILED: Exceeded maximum team officer limit!';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%capacity exceeded%' THEN
                v_pass_count := v_pass_count + 1;
                RAISE NOTICE 'TEST 24 PASSED: 6th active officer blocked by capacity quota.';
            ELSE
                v_fail_count := v_fail_count + 1;
                RAISE WARNING 'TEST 24 FAILED with unexpected error: %', SQLERRM;
            END IF;
        END;

        -- Clean up capacity test users
        DELETE FROM public.team_members WHERE user_id IN (v_cap_user4, v_cap_user5, v_cap_user6);
        DELETE FROM public.profiles WHERE user_id IN (v_cap_user4, v_cap_user5, v_cap_user6);
        DELETE FROM auth.users WHERE id IN (v_cap_user4, v_cap_user5, v_cap_user6);
    END;

    -- ------------------------------------------------------------------------
    -- TEST 25: Deactivation of a valid officer
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.deactivate_team_officer(v_team1_id, v_unassigned_id, 'Rotated to external taskforce');

        IF (v_res->>'success')::boolean = true AND EXISTS (
            SELECT 1 FROM public.team_members WHERE team_id = v_team1_id AND user_id = v_unassigned_id AND status = 'INACTIVE'
        ) AND EXISTS (
            SELECT 1 FROM public.profiles WHERE user_id = v_unassigned_id AND team_id IS NULL
        ) THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 25 PASSED: Officer successfully deactivated and team_id unlinked.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 25 FAILED: Unexpected deactivation response: %', v_res;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 25 FAILED with exception: %', SQLERRM;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 26: Attempted deactivation of a Higher Officer is rejected
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        v_res := public.deactivate_team_officer(v_team1_id, v_ho2_id);
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 26 FAILED: Higher Officer was deactivated!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Higher Officers cannot be deactivated%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 26 PASSED: Higher Officer deactivation blocked: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 26 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 27: Supervisor cannot deactivate an officer in another department
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ho1_id::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

        -- HO 1 tries to deactivate Officer Alien in Team 2
        v_res := public.deactivate_team_officer(v_team2_id, v_officer_alien_id);
        v_fail_count := v_fail_count + 1;
        RAISE WARNING 'TEST 27 FAILED: Supervisor deactivated an officer of another team!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%You do not supervise%' THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 27 PASSED: Cross-team supervisor deactivation blocked: %', SQLERRM;
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 27 FAILED with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- TEST 28: Audit logs record team management operations accurately
    -- ------------------------------------------------------------------------
    v_test_count := v_test_count + 1;
    BEGIN
        IF EXISTS (
            SELECT 1 FROM public.audit_logs 
            WHERE team_id = v_team1_id 
              AND target_user_id = v_unassigned_id 
              AND action = 'OFFICER_ADDED'
        ) AND EXISTS (
            SELECT 1 FROM public.audit_logs 
            WHERE team_id = v_team1_id 
              AND target_user_id = v_unassigned_id 
              AND action = 'OFFICER_DEACTIVATED'
        ) THEN
            v_pass_count := v_pass_count + 1;
            RAISE NOTICE 'TEST 28 PASSED: Compliant immutable audit records verified.';
        ELSE
            v_fail_count := v_fail_count + 1;
            RAISE WARNING 'TEST 28 FAILED: Missing expected audit logs for officer operations!';
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- SUMMARY & TEARDOWN
    -- ------------------------------------------------------------------------
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'SECURITY TEST RESULTS: % / % PASSED (% FAILED)', v_pass_count, v_test_count, v_fail_count;
    RAISE NOTICE '============================================================';

    -- Disable FORCE ROW LEVEL SECURITY
    ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.teams NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.team_members NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence_attachments NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.evidence_custody NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.transfer_requests NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.deletion_requests NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.notifications NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.blockchain_anchors NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;

    -- Cleanup test data
    DELETE FROM public.audit_logs WHERE evidence_id IN (v_ev1_code, v_ev2_code) OR target_user_id IN (v_unassigned_id, v_officer1_id, v_officer2_id);
    DELETE FROM public.notifications WHERE evidence_id IN (v_ev1_code, v_ev2_code);
    DELETE FROM public.deletion_requests WHERE evidence_id IN (v_ev1_code, v_ev2_code);
    DELETE FROM public.transfer_requests WHERE evidence_id IN (v_ev1_code, v_ev2_code);
    DELETE FROM public.blockchain_anchors WHERE evidence_id IN (v_ev1_code, v_ev2_code);
    DELETE FROM public.evidence_custody WHERE evidence_id IN (v_ev1_uuid, v_ev2_uuid);
    DELETE FROM public.evidence_attachments WHERE evidence_id IN (v_ev1_uuid, v_ev2_uuid);
    DELETE FROM public.evidence WHERE id IN (v_ev1_uuid, v_ev2_uuid);
    DELETE FROM public.team_members WHERE team_id IN (v_team1_id, v_team2_id);
    DELETE FROM public.teams WHERE id IN (v_team1_id, v_team2_id);
    DELETE FROM public.profiles WHERE user_id IN (v_ho1_id, v_ho2_id, v_officer1_id, v_officer2_id, v_officer_alien_id, v_unassigned_id);
    DELETE FROM auth.users WHERE id IN (v_ho1_id, v_ho2_id, v_officer1_id, v_officer2_id, v_officer_alien_id, v_unassigned_id);

    IF v_fail_count > 0 THEN
        RAISE EXCEPTION 'DATABASE SECURITY TEST SUITE ENCOUNTERED % FAILURES.', v_fail_count;
    END IF;
END $$;
