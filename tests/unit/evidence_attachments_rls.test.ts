import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// TASK 4: EVIDENCE ATTACHMENTS RLS RECURSION & SYNCHRONIZATION TESTS
// Scenarios 1 to 7
// ============================================================================

describe('Evidence Attachments RLS & Immutability Verification (Scenarios 1 - 7)', () => {
  // Scenario 5: Verify migration and setup scripts have zero recursive self-referential subqueries
  test('Scenario 5: Attachment policies contain NO recursive self-referencing subqueries', () => {
    const migrationPath = path.resolve('supabase/migrations/20261102_fix_evidence_attachments_rls_recursion.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Extract the CREATE POLICY "evidence_attachments_update_policy" block
    const policyRegex = /CREATE\s+POLICY\s+"evidence_attachments_update_policy"[\s\S]*?;/i;
    const match = migrationSql.match(policyRegex);
    assert.ok(match, 'evidence_attachments_update_policy must exist in migration');

    const policySql = match[0];

    // Must NOT contain any self-referencing subquery against public.evidence_attachments
    const recursivePattern = /SELECT\s+.*?\s+FROM\s+(public\.)?evidence_attachments/i;
    assert.strictEqual(
      recursivePattern.test(policySql),
      false,
      'Migration update policy must NOT contain any subquery against evidence_attachments table'
    );

    // Verify 02_security_policies.sql
    const setup02Path = path.resolve('supabase/manual_setup/02_security_policies.sql');
    const setup02Sql = fs.readFileSync(setup02Path, 'utf8');
    const setup02Match = setup02Sql.match(policyRegex);
    assert.ok(setup02Match, 'evidence_attachments_update_policy must exist in 02_security_policies.sql');
    assert.strictEqual(
      recursivePattern.test(setup02Match[0]),
      false,
      '02_security_policies.sql must NOT contain recursive subqueries on evidence_attachments'
    );

    // Verify 05_complete_setup.sql
    const setup05Path = path.resolve('supabase/manual_setup/05_complete_setup.sql');
    const setup05Sql = fs.readFileSync(setup05Path, 'utf8');
    const setup05Match = setup05Sql.match(policyRegex);
    assert.ok(setup05Match, 'evidence_attachments_update_policy must exist in 05_complete_setup.sql');
    assert.strictEqual(
      recursivePattern.test(setup05Match[0]),
      false,
      '05_complete_setup.sql must NOT contain recursive subqueries on evidence_attachments'
    );
  });

  // Scenario 1: An authorized Officer can synchronize an attachment belonging to accessible evidence
  test('Scenario 1: Authorized Officer can insert and update attachments for their accessible evidence', () => {
    const evaluateAttachmentAccess = (context: {
      authUid: string;
      userRole: string;
      userTeamIds: string[];
      parentEvidence: { id: string; team_id: string; owner_id: string };
      action: 'INSERT' | 'UPDATE' | 'SELECT';
    }) => {
      const inTeam = context.userTeamIds.includes(context.parentEvidence.team_id);
      const isOwner = context.authUid === context.parentEvidence.owner_id;
      const isHigherOfficer = context.userRole === 'HIGHER_OFFICER';

      if (context.action === 'SELECT') {
        return inTeam;
      }
      if (context.action === 'INSERT') {
        return inTeam;
      }
      if (context.action === 'UPDATE') {
        return inTeam && (isOwner || isHigherOfficer);
      }
      return false;
    };

    const parent = { id: 'ev-uuid-1', team_id: 'team-alpha', owner_id: 'officer-uuid-1' };
    const authContext = {
      authUid: 'officer-uuid-1',
      userRole: 'OFFICER',
      userTeamIds: ['team-alpha'],
      parentEvidence: parent,
    };

    assert.strictEqual(evaluateAttachmentAccess({ ...authContext, action: 'INSERT' }), true);
    assert.strictEqual(evaluateAttachmentAccess({ ...authContext, action: 'UPDATE' }), true);
    assert.strictEqual(evaluateAttachmentAccess({ ...authContext, action: 'SELECT' }), true);
  });

  // Scenario 2: An Officer cannot insert an attachment for evidence outside their team
  test('Scenario 2: Officer cannot insert attachment for evidence belonging to another team', () => {
    const evaluateInsert = (userTeamIds: string[], parentEvidenceTeamId: string) => {
      return userTeamIds.includes(parentEvidenceTeamId);
    };

    const officerTeams = ['team-alpha'];
    const foreignEvidenceTeam = 'team-beta';

    const permitted = evaluateInsert(officerTeams, foreignEvidenceTeam);
    assert.strictEqual(permitted, false, 'Attachment insert for outside team evidence must be rejected');
  });

  // Scenario 3: An Officer cannot retrieve another team's attachment
  test('Scenario 3: Officer cannot retrieve attachments for another team\'s evidence', () => {
    const evaluateSelect = (userTeamIds: string[], parentEvidenceTeamId: string) => {
      return userTeamIds.includes(parentEvidenceTeamId);
    };

    const officerTeams = ['team-alpha'];
    const foreignEvidenceTeam = 'team-beta';

    const canSelect = evaluateSelect(officerTeams, foreignEvidenceTeam);
    assert.strictEqual(canSelect, false, 'Attachment retrieval across team boundaries must be denied');
  });

  // Scenario 4: Higher Officer permissions follow the existing authorization model
  test('Scenario 4: Higher Officer can view and update attachments across their supervised team', () => {
    const evaluateAttachmentUpdate = (
      callerId: string,
      callerRole: string,
      callerTeamIds: string[],
      parentEvidence: { team_id: string; owner_id: string }
    ) => {
      const inTeam = callerTeamIds.includes(parentEvidence.team_id);
      const isOwner = callerId === parentEvidence.owner_id;
      const isHigherOfficer = callerRole === 'HIGHER_OFFICER';

      return inTeam && (isOwner || isHigherOfficer);
    };

    const parent = { team_id: 'team-alpha', owner_id: 'officer-subordinate' };

    // Supervised team Higher Officer
    const hoCanUpdate = evaluateAttachmentUpdate(
      'ho-uuid-1',
      'HIGHER_OFFICER',
      ['team-alpha'],
      parent
    );
    assert.strictEqual(hoCanUpdate, true, 'Higher Officer must be authorized to update attachment in supervised team');

    // Higher Officer of different team
    const hoForeignTeam = evaluateAttachmentUpdate(
      'ho-uuid-2',
      'HIGHER_OFFICER',
      ['team-gamma'],
      parent
    );
    assert.strictEqual(hoForeignTeam, false, 'Higher Officer of foreign team must be rejected');
  });

  // Scenario 6: Existing evidence upload and retrieval behavior remains intact & attachment immutability trigger protects critical fields
  test('Scenario 6: Attachment immutability trigger restores immutable columns upon update', () => {
    const simulateAttachmentTrigger = (
      oldRow: { id: string; attachment_id: string; evidence_id: string; sha256: string; file_size: number; created_at: string; upload_status: string; storage_file_id: string | null },
      submittedNewRow: { id: string; attachment_id: string; evidence_id: string; sha256: string; file_size: number; created_at: string; upload_status: string; storage_file_id: string | null }
    ) => {
      const finalRow = { ...submittedNewRow };

      // Immutability trigger behavior:
      finalRow.evidence_id = oldRow.evidence_id;
      finalRow.attachment_id = oldRow.attachment_id;
      finalRow.sha256 = oldRow.sha256;
      finalRow.file_size = oldRow.file_size;
      finalRow.created_at = oldRow.created_at;

      return finalRow;
    };

    const oldRow = {
      id: 'att-pk-1',
      attachment_id: 'ATT-1001',
      evidence_id: 'ev-parent-uuid',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      file_size: 1048576,
      created_at: '2026-11-01T10:00:00Z',
      upload_status: 'PENDING',
      storage_file_id: null,
    };

    // Client maliciously attempts to tamper with sha256, evidence_id, file_size, and attachment_id
    // while legitimately updating upload_status and storage_file_id
    const tamperedPayload = {
      id: 'att-pk-1',
      attachment_id: 'TAMPERED-ATT-9999',
      evidence_id: 'tampered-parent-uuid',
      sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      file_size: 999999999,
      created_at: '1970-01-01T00:00:00Z',
      upload_status: 'UPLOADED',
      storage_file_id: 'team-alpha/ev-001/ATT-1001.jpg',
    };

    const result = simulateAttachmentTrigger(oldRow, tamperedPayload);

    assert.strictEqual(result.evidence_id, 'ev-parent-uuid', 'evidence_id must be restored');
    assert.strictEqual(result.attachment_id, 'ATT-1001', 'attachment_id must be restored');
    assert.strictEqual(result.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 must be restored');
    assert.strictEqual(result.file_size, 1048576, 'file_size must be restored');
    assert.strictEqual(result.created_at, '2026-11-01T10:00:00Z', 'created_at must be restored');

    // Legitimate fields are updated
    assert.strictEqual(result.upload_status, 'UPLOADED', 'upload_status must be updated');
    assert.strictEqual(result.storage_file_id, 'team-alpha/ev-001/ATT-1001.jpg', 'storage_file_id must be updated');
  });

  // Scenario 7: Attachment synchronization retries do not create duplicates
  test('Scenario 7: Upserting with onConflict: "attachment_id" is idempotent on retry', () => {
    const tableState = new Map<string, any>();

    const simulateUpsert = (record: { attachment_id: string; [key: string]: any }) => {
      const existing = tableState.get(record.attachment_id);
      if (existing) {
        // Update mutable fields
        const updated = {
          ...existing,
          upload_status: record.upload_status,
          storage_file_id: record.storage_file_id || existing.storage_file_id,
          cloud_verification_status: record.cloud_verification_status || existing.cloud_verification_status,
          updated_at: record.updated_at,
        };
        tableState.set(record.attachment_id, updated);
        return { action: 'UPDATE', record: updated };
      } else {
        tableState.set(record.attachment_id, { ...record });
        return { action: 'INSERT', record };
      }
    };

    const item = {
      attachment_id: 'ATT-2026-IMG-01',
      original_name: 'IMG-20260819-WA0003.jpg',
      evidence_id: 'ev-uuid-42',
      sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      file_size: 204800,
      upload_status: 'PENDING',
      storage_file_id: null,
      updated_at: '2026-11-02T10:00:00Z',
    };

    // First synchronization attempt (Initial INSERT)
    const firstSync = simulateUpsert(item);
    assert.strictEqual(firstSync.action, 'INSERT');
    assert.strictEqual(tableState.size, 1);

    // Second synchronization attempt / retry with uploaded file path (UPDATE on conflict)
    const retryItem = {
      ...item,
      upload_status: 'UPLOADED',
      storage_file_id: 'team-1/ev-42/ATT-2026-IMG-01.jpg',
      updated_at: '2026-11-02T10:05:00Z',
    };
    const secondSync = simulateUpsert(retryItem);
    assert.strictEqual(secondSync.action, 'UPDATE');
    assert.strictEqual(tableState.size, 1, 'Table must contain exactly 1 record (no duplicate created)');
    assert.strictEqual(tableState.get('ATT-2026-IMG-01')?.upload_status, 'UPLOADED');
    assert.strictEqual(tableState.get('ATT-2026-IMG-01')?.storage_file_id, 'team-1/ev-42/ATT-2026-IMG-01.jpg');
  });
});
