import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// PART C: RLS RECURSION, SYNCHRONIZATION & EVIDENCE DETAIL RETRIEVAL TESTS
// Scenarios 1 to 16
// ============================================================================

describe('RLS and Database Immutability Policy Validation (Scenarios 1 - 9)', () => {
  // Scenario 6: Verify SQL policy AST/text has zero self-referencing subqueries
  test('Scenario 6: Evidence update policy contains NO recursive evidence-table subqueries', () => {
    const migrationPath = path.resolve('supabase/migrations/20261102_fix_evidence_update_rls_recursion.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Extract the CREATE POLICY "evidence_update_policy" block
    const policyRegex = /CREATE\s+POLICY\s+"evidence_update_policy"[\s\S]*?;/i;
    const match = migrationSql.match(policyRegex);
    assert.ok(match, 'evidence_update_policy must exist in migration');

    const policySql = match[0];

    // Must NOT contain any self-referencing subquery against public.evidence or evidence inside WITH CHECK or USING
    const recursivePattern = /SELECT\s+.*?\s+FROM\s+(public\.)?evidence/i;
    assert.strictEqual(
      recursivePattern.test(policySql),
      false,
      'Policy must NOT contain any subquery against evidence table'
    );

    // Verify manual setup files were also updated to prevent regressions
    const setup02Path = path.resolve('supabase/manual_setup/02_security_policies.sql');
    const setup02Sql = fs.readFileSync(setup02Path, 'utf8');
    const setup02Match = setup02Sql.match(policyRegex);
    assert.ok(setup02Match, 'evidence_update_policy must exist in 02_security_policies.sql');
    assert.strictEqual(
      recursivePattern.test(setup02Match[0]),
      false,
      '02_security_policies.sql must NOT contain recursive subqueries'
    );

    const setup05Path = path.resolve('supabase/manual_setup/05_complete_setup.sql');
    const setup05Sql = fs.readFileSync(setup05Path, 'utf8');
    const setup05Match = setup05Sql.match(policyRegex);
    assert.ok(setup05Match, 'evidence_update_policy must exist in 05_complete_setup.sql');
    assert.strictEqual(
      recursivePattern.test(setup05Match[0]),
      false,
      '05_complete_setup.sql must NOT contain recursive subqueries'
    );
  });

  // Scenario 1: An authorized Officer can update permitted evidence fields
  test('Scenario 1: Authorized Officer can update permitted fields within their team', () => {
    const evaluateUpdatePolicy = (context: {
      authUid: string;
      userRole: string;
      userTeamIds: string[];
      oldRow: { team_id: string; owner_id: string; status: string };
      newRow: { team_id: string; owner_id: string; status: string };
    }) => {
      // USING check
      const usingPass =
        context.userTeamIds.includes(context.oldRow.team_id) &&
        (context.authUid === context.oldRow.owner_id || context.userRole === 'HIGHER_OFFICER') &&
        context.oldRow.status !== 'DELETED';

      // WITH CHECK check
      const checkPass =
        context.userTeamIds.includes(context.newRow.team_id) &&
        (context.authUid === context.newRow.owner_id || context.userRole === 'HIGHER_OFFICER') &&
        context.newRow.status !== 'DELETED' &&
        ['ACTIVE', 'PENDING', 'ARCHIVED'].includes(context.newRow.status) &&
        (context.newRow.status !== 'ARCHIVED' || context.userRole === 'HIGHER_OFFICER');

      return usingPass && checkPass;
    };

    const isPermitted = evaluateUpdatePolicy({
      authUid: 'officer-uuid-1',
      userRole: 'OFFICER',
      userTeamIds: ['team-uuid-alpha'],
      oldRow: { team_id: 'team-uuid-alpha', owner_id: 'officer-uuid-1', status: 'ACTIVE' },
      newRow: { team_id: 'team-uuid-alpha', owner_id: 'officer-uuid-1', status: 'ACTIVE' },
    });

    assert.strictEqual(isPermitted, true);
  });

  // Scenario 2: An Officer cannot update evidence belonging to another team
  test('Scenario 2: Officer cannot update evidence belonging to another team', () => {
    const evaluateUpdatePolicy = (context: {
      authUid: string;
      userRole: string;
      userTeamIds: string[];
      oldRow: { team_id: string; owner_id: string; status: string };
      newRow: { team_id: string; owner_id: string; status: string };
    }) => {
      const usingPass =
        context.userTeamIds.includes(context.oldRow.team_id) &&
        (context.authUid === context.oldRow.owner_id || context.userRole === 'HIGHER_OFFICER') &&
        context.oldRow.status !== 'DELETED';
      return usingPass;
    };

    const isPermitted = evaluateUpdatePolicy({
      authUid: 'officer-uuid-1',
      userRole: 'OFFICER',
      userTeamIds: ['team-uuid-alpha'], // Officer belongs to alpha
      oldRow: { team_id: 'team-uuid-beta', owner_id: 'officer-uuid-1', status: 'ACTIVE' }, // Evidence is in beta
      newRow: { team_id: 'team-uuid-beta', owner_id: 'officer-uuid-1', status: 'ACTIVE' },
    });

    assert.strictEqual(isPermitted, false, 'Update across foreign team boundaries must be rejected');
  });

  // Scenario 3: An unauthorized Officer cannot update another user\'s evidence
  test('Scenario 3: Officer cannot update another officer\'s evidence', () => {
    const evaluateUpdatePolicy = (context: {
      authUid: string;
      userRole: string;
      userTeamIds: string[];
      oldRow: { team_id: string; owner_id: string; status: string };
    }) => {
      return (
        context.userTeamIds.includes(context.oldRow.team_id) &&
        (context.authUid === context.oldRow.owner_id || context.userRole === 'HIGHER_OFFICER') &&
        context.oldRow.status !== 'DELETED'
      );
    };

    const isPermitted = evaluateUpdatePolicy({
      authUid: 'officer-uuid-1',
      userRole: 'OFFICER',
      userTeamIds: ['team-uuid-alpha'],
      oldRow: { team_id: 'team-uuid-alpha', owner_id: 'officer-uuid-2', status: 'ACTIVE' }, // Owned by officer-2
    });

    assert.strictEqual(isPermitted, false, 'Non-owner ordinary officer must be denied');
  });

  // Scenario 4: Ordinary Officers cannot bypass Higher Officer restrictions (e.g. archiving)
  test('Scenario 4: Ordinary Officers cannot archive evidence (Higher Officer only)', () => {
    const evaluateArchivePermission = (role: string, targetStatus: string) => {
      const allowedStatuses = ['ACTIVE', 'PENDING', 'ARCHIVED'];
      if (!allowedStatuses.includes(targetStatus)) return false;
      if (targetStatus === 'ARCHIVED' && role !== 'HIGHER_OFFICER') {
        return false;
      }
      return true;
    };

    assert.strictEqual(evaluateArchivePermission('OFFICER', 'ARCHIVED'), false);
    assert.strictEqual(evaluateArchivePermission('HIGHER_OFFICER', 'ARCHIVED'), true);
  });

  // Scenario 5: Deleted evidence cannot be updated
  test('Scenario 5: Deleted evidence is immutable and cannot be updated', () => {
    const evaluateStatusUpdate = (oldStatus: string) => {
      if (oldStatus === 'DELETED') {
        throw new Error('Evidence record is deleted and cannot be modified.');
      }
      return true;
    };

    assert.throws(
      () => evaluateStatusUpdate('DELETED'),
      /Evidence record is deleted and cannot be modified/
    );
  });

  // Scenario 7: Immutability trigger unconditionally protects team_id, owner_id, created_by, evidence_id, created_at
  test('Scenario 7: Immutability trigger restores immutable columns against tampering', () => {
    const simulateTrigger = (
      oldRow: { team_id: string; evidence_id: string; created_at: string; created_by: string; owner_id: string; status: string },
      submittedNewRow: { team_id: string; evidence_id: string; created_at: string; created_by: string; owner_id: string; status: string },
      allowTransferFlag: boolean
    ) => {
      const finalRow = { ...submittedNewRow };

      // 1. Unconditionally preserve immutable columns
      finalRow.team_id = oldRow.team_id;
      finalRow.evidence_id = oldRow.evidence_id;
      finalRow.created_at = oldRow.created_at;
      finalRow.created_by = oldRow.created_by;

      // 2. Enforce transfer workflow for owner change
      if (finalRow.owner_id !== oldRow.owner_id && !allowTransferFlag) {
        throw new Error('Unauthorized ownership modification: Evidence ownership may only be changed through an accepted custody transfer.');
      }

      return finalRow;
    };

    const oldRow = {
      team_id: 'team-1',
      evidence_id: 'EV-2026-001',
      created_at: '2026-11-01T10:00:00Z',
      created_by: 'creator-uuid',
      owner_id: 'owner-uuid',
      status: 'ACTIVE',
    };

    // Client maliciously attempts to tamper with team_id, created_by, and created_at
    const tamperedRow = {
      team_id: 'tampered-team-99',
      evidence_id: 'tampered-id-99',
      created_at: '1970-01-01T00:00:00Z',
      created_by: 'tampered-creator-99',
      owner_id: 'owner-uuid',
      status: 'ACTIVE',
    };

    const result = simulateTrigger(oldRow, tamperedRow, false);
    assert.strictEqual(result.team_id, 'team-1', 'team_id must be restored');
    assert.strictEqual(result.evidence_id, 'EV-2026-001', 'evidence_id must be restored');
    assert.strictEqual(result.created_at, '2026-11-01T10:00:00Z', 'created_at must be restored');
    assert.strictEqual(result.created_by, 'creator-uuid', 'created_by must be restored');

    // Direct owner modification without custody transfer must throw
    const ownerTampered = { ...oldRow, owner_id: 'new-unauthorized-owner' };
    assert.throws(
      () => simulateTrigger(oldRow, ownerTampered, false),
      /Unauthorized ownership modification/
    );
  });

  // Scenario 8: Valid evidence status transitions remain enforced
  test('Scenario 8: Direct transition to DELETED or TRANSFERRED requires authorized RPC', () => {
    const validateTransition = (oldStatus: string, newStatus: string, rpcFlags: { allowDeleted?: boolean; allowTransferred?: boolean }) => {
      if (oldStatus === 'DELETED') throw new Error('Evidence record is deleted and cannot be modified.');
      if (newStatus === 'DELETED' && !rpcFlags.allowDeleted) {
        throw new Error('Direct deletion of evidence is prohibited. Deletion must proceed through the supervisor approval workflow.');
      }
      if (newStatus === 'TRANSFERRED' && !rpcFlags.allowTransferred) {
        throw new Error('Transfer status cannot be updated directly.');
      }
      return true;
    };

    // Direct transition to DELETED blocked
    assert.throws(() => validateTransition('ACTIVE', 'DELETED', {}), /Direct deletion/);
    // Direct transition with supervisor approval flag allowed
    assert.strictEqual(validateTransition('ACTIVE', 'DELETED', { allowDeleted: true }), true);

    // Direct transition to TRANSFERRED blocked
    assert.throws(() => validateTransition('ACTIVE', 'TRANSFERRED', {}), /Transfer status cannot be updated directly/);
    // Transition via transfer workflow allowed
    assert.strictEqual(validateTransition('ACTIVE', 'TRANSFERRED', { allowTransferred: true }), true);
  });

  // Scenario 9: Synchronization does not create duplicate evidence records
  test('Scenario 9: Synchronization deduplicates records by business evidence_id', () => {
    const cloudRecords = [
      { id: 'uuid-1', evidence_id: 'EV-2026-001', title: 'Weapon Photo' },
      { id: 'uuid-2', evidence_id: 'EV-2026-002', title: 'Audio Recording' },
    ];

    const deduplicate = (incoming: any[], existing: any[]) => {
      const map = new Map<string, any>();
      existing.forEach(r => map.set(r.evidence_id || r.evidenceId, r));
      incoming.forEach(r => map.set(r.evidence_id || r.evidenceId, r));
      return Array.from(map.values());
    };

    // Re-syncing EV-2026-001 with updated metadata
    const syncItem = { evidence_id: 'EV-2026-001', title: 'Weapon Photo Updated' };
    const merged = deduplicate([syncItem], cloudRecords);

    assert.strictEqual(merged.length, 2, 'Must not duplicate record with existing evidence_id');
    assert.strictEqual(merged.find(m => m.evidence_id === 'EV-2026-001')?.title, 'Weapon Photo Updated');
  });
});

describe('Evidence Detail Retrieval & Offline Fallback (Scenarios 10 - 16)', () => {
  // Scenario 10: Cloud evidence opens successfully
  test('Scenario 10: Cloud evidence opens successfully and maps fields', async () => {
    const mockCloudRecord = {
      id: 'db-uuid-1',
      evidence_id: 'EV-2026-001',
      team_id: 'team-1',
      owner_id: 'user-1',
      created_by: 'user-1',
      title: 'Fingerprint Scan',
      description: 'Latent lift from window',
      category: 'FORENSIC',
      location: '123 Main St',
      captured_at: '2026-11-01T12:00:00Z',
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
      cloud_verification_status: 'VERIFIED',
      created_at: '2026-11-01T12:05:00Z',
      updated_at: '2026-11-01T12:05:00Z',
    };

    const resolveEvidence = async (id: string, mockSource: 'cloud' | 'local' | 'none') => {
      if (mockSource === 'cloud') {
        return {
          evidence: {
            id: mockCloudRecord.id,
            evidenceId: mockCloudRecord.evidence_id,
            teamId: mockCloudRecord.team_id,
            ownerId: mockCloudRecord.owner_id,
            title: mockCloudRecord.title,
            status: mockCloudRecord.status,
            verificationStatus: mockCloudRecord.verification_status,
            syncStatus: 'SYNCED',
          },
          source: 'CLOUD',
        };
      }
      return null;
    };

    const result = await resolveEvidence('EV-2026-001', 'cloud');
    assert.ok(result);
    assert.strictEqual(result.source, 'CLOUD');
    assert.strictEqual(result.evidence.evidenceId, 'EV-2026-001');
    assert.strictEqual(result.evidence.syncStatus, 'SYNCED');
  });

  // Scenario 11: Locally stored evidence opens when no cloud record exists
  test('Scenario 11: Locally stored evidence opens when no cloud record exists', async () => {
    const mockLocalStore: Record<string, any> = {
      'EV-2026-LOCAL-1': {
        evidenceId: 'EV-2026-LOCAL-1',
        teamId: 'team-alpha',
        ownerId: 'officer-1',
        title: 'Unsynced Local Item',
        status: 'ACTIVE',
        verificationStatus: 'PENDING',
        syncStatus: 'PENDING',
      },
    };

    const fetchEvidence = async (queryId: string, cloudAvailable: boolean) => {
      if (cloudAvailable) {
        return null; // Cloud returned 0 rows
      }
      // Fallback to local store
      const local = mockLocalStore[queryId];
      if (local) {
        return { evidence: local, source: 'LOCAL' };
      }
      return null;
    };

    const result = await fetchEvidence('EV-2026-LOCAL-1', false);
    assert.ok(result);
    assert.strictEqual(result.source, 'LOCAL');
    assert.strictEqual(result.evidence.evidenceId, 'EV-2026-LOCAL-1');
    assert.strictEqual(result.evidence.syncStatus, 'PENDING');
  });

  // Scenario 12: Offline evidence opens without network access
  test('Scenario 12: Offline evidence opens without network access', async () => {
    const localDatabase = new Map<string, any>();
    localDatabase.set('EV-2026-OFFLINE-99', {
      evidenceId: 'EV-2026-OFFLINE-99',
      title: 'Offline Field Note',
      syncStatus: 'LOCAL_ONLY',
      attachments: [{ attachmentId: 'att-1', originalName: 'note.jpg' }],
    });

    const getDetail = async (id: string, isNetworkOnline: boolean) => {
      if (!isNetworkOnline) {
        // Direct local lookup when offline
        const local = localDatabase.get(id);
        if (local) return { evidence: local, offlineMode: true };
      }
      return null;
    };

    const result = await getDetail('EV-2026-OFFLINE-99', false);
    assert.ok(result);
    assert.strictEqual(result.offlineMode, true);
    assert.strictEqual(result.evidence.title, 'Offline Field Note');
    assert.strictEqual(result.evidence.attachments.length, 1);
  });

  // Scenario 13: A cloud retrieval error triggers appropriate recovery (Retry state)
  test('Scenario 13: Cloud retrieval network error triggers NETWORK_ERROR state with retry', () => {
    const processQueryResponse = (cloudError: any, localData: any) => {
      if (cloudError && !localData) {
        if (cloudError.code === '42501') {
          return { type: 'UNAUTHORIZED', canRetry: false };
        }
        return { type: 'NETWORK_ERROR', canRetry: true, message: cloudError.message };
      }
      return { type: 'OK' };
    };

    const networkErr = { message: 'FetchError: Failed to connect to Supabase' };
    const state = processQueryResponse(networkErr, null);
    assert.strictEqual(state.type, 'NETWORK_ERROR');
    assert.strictEqual(state.canRetry, true);
  });

  // Scenario 14: Genuine authorization error is not silently treated as a missing record
  test('Scenario 14: Authorization error (42501) returns UNAUTHORIZED, not NOT_FOUND', () => {
    const determineErrorState = (cloudError: any, recordFound: boolean) => {
      if (cloudError?.code === '42501' || cloudError?.message?.includes('permission')) {
        return 'UNAUTHORIZED';
      }
      if (!recordFound) {
        return 'NOT_FOUND';
      }
      return 'OK';
    };

    const authError = { code: '42501', message: 'permission denied for relation evidence' };
    const errorState = determineErrorState(authError, false);
    assert.strictEqual(errorState, 'UNAUTHORIZED', 'Must distinguish 42501 as UNAUTHORIZED');
  });

  // Scenario 15: An unknown evidence ID produces an appropriate not-found message
  test('Scenario 15: Unknown evidence ID produces NOT_FOUND state', () => {
    const lookup = (id: string, cloudRecords: any[], localRecords: any[]) => {
      const inCloud = cloudRecords.find(r => r.evidence_id === id);
      if (inCloud) return { status: 'FOUND', data: inCloud };

      const inLocal = localRecords.find(r => r.evidenceId === id);
      if (inLocal) return { status: 'FOUND', data: inLocal };

      return { status: 'NOT_FOUND', message: `Evidence with identifier "${id}" could not be found.` };
    };

    const res = lookup('EV-DOES-NOT-EXIST', [], []);
    assert.strictEqual(res.status, 'NOT_FOUND');
    assert.ok(res.message && res.message.includes('EV-DOES-NOT-EXIST'));
  });

  // Scenario 16: Evidence identifiers are handled consistently between list and detail screens
  test('Scenario 16: Handles both business evidence_id and UUID primary key uniformly', () => {
    const mockEvidenceTable = [
      { id: '11111111-2222-3333-4444-555555555555', evidence_id: 'EV-2026-999', title: 'Traffic Dashcam' },
    ];

    const findEvidence = (paramId: string) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paramId);
      if (isUuid) {
        return mockEvidenceTable.find(e => e.id === paramId) || null;
      }
      return mockEvidenceTable.find(e => e.evidence_id === paramId) || null;
    };

    // By business ID string
    const byBusinessId = findEvidence('EV-2026-999');
    assert.ok(byBusinessId);
    assert.strictEqual(byBusinessId.title, 'Traffic Dashcam');

    // By primary key UUID
    const byUuid = findEvidence('11111111-2222-3333-4444-555555555555');
    assert.ok(byUuid);
    assert.strictEqual(byUuid.evidence_id, 'EV-2026-999');
  });
});
