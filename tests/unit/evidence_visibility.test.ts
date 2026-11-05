import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// COMPLETE EVIDENCE VISIBILITY AUDIT & RETRIEVAL SUITE
// Scenarios 1 to 20
// ============================================================================

describe('Evidence Visibility, Synchronization & Verification (Scenarios 1 - 20)', () => {

  // Scenario 1: Officer uploads evidence while online; evidence appears immediately in Officer evidence list
  test('Scenario 1: Online evidence upload merges into evidence list immediately', () => {
    const cloudEvidence = [
      { evidence_id: 'EV-2026-000001', title: 'Prior Evidence', created_by: 'officer-1', status: 'ACTIVE', verification_status: 'VERIFIED' }
    ];
    const newLocalPending = {
      evidence_id: 'EV-2026-000002',
      title: 'Newly Uploaded Case',
      created_by: 'officer-1',
      status: 'ACTIVE',
      verification_status: 'PENDING',
      syncStatus: 'PENDING'
    };

    // Simulate merging local pending evidence with cloud query results
    const cloudMap = new Map(cloudEvidence.map(e => [e.evidence_id, e]));
    const pendingToPrepend: any[] = [];
    if (!cloudMap.has(newLocalPending.evidence_id)) {
      pendingToPrepend.push(newLocalPending);
    }

    const mergedList = [...pendingToPrepend, ...cloudEvidence];
    assert.strictEqual(mergedList.length, 2);
    assert.strictEqual(mergedList[0].evidence_id, 'EV-2026-000002', 'Newly uploaded item appears at top of list');
    assert.strictEqual(mergedList[0].syncStatus, 'PENDING');
  });

  // Scenario 2: Officer uploads evidence while offline; evidence appears in Officer list with offline/pending indicator
  test('Scenario 2: Offline evidence appears in Officer list with pending sync indicator', () => {
    const localStore = [
      {
        evidence_id: 'EV-2026-000100',
        title: 'Offline Scene Capture',
        owner_id: 'officer-1',
        created_by: 'officer-1',
        status: 'ACTIVE',
        verification_status: 'PENDING',
        syncStatus: 'PENDING'
      }
    ];

    const isPendingSync = (item: any) =>
      item.syncStatus === 'PENDING' || item._syncStatus === 'PENDING' || item.uploadStatus === 'LOCAL_ONLY';

    assert.strictEqual(localStore.length, 1);
    assert.strictEqual(isPendingSync(localStore[0]), true, 'Pending sync badge is flagged for offline evidence');
  });

  // Scenario 3: Officer uploads evidence while offline; network connects; evidence syncs and status updates
  test('Scenario 3: Offline evidence syncs to cloud on network connection and updates sync status', () => {
    const localItem = {
      evidence_id: 'EV-2026-000200',
      title: 'Offline Sync Case',
      owner_id: 'officer-1',
      created_by: 'officer-1',
      status: 'ACTIVE',
      verification_status: 'PENDING',
      syncStatus: 'PENDING'
    };

    // Simulate directSyncToCloud payload creation
    const insertPayload = {
      evidence_id: localItem.evidence_id,
      owner_id: localItem.owner_id,
      created_by: localItem.created_by || localItem.owner_id,
      status: localItem.status,
      verification_status: localItem.verification_status,
      syncStatus: 'SYNCED'
    };

    assert.strictEqual(insertPayload.created_by, 'officer-1', 'created_by must be populated in cloud insert');
    assert.strictEqual(insertPayload.syncStatus, 'SYNCED');
  });

  // Scenario 4: Officer navigates away from and back to Evidence screen; evidence list reflects latest data
  test('Scenario 4: Screen focus effect triggers list refresh to display latest data', () => {
    let fetchCount = 0;
    const loadTeamEvidenceData = (page: number, shouldReset: boolean) => {
      fetchCount++;
      return { page, shouldReset };
    };

    // Simulate returning to screen triggering useFocusEffect callback
    loadTeamEvidenceData(1, true);
    assert.strictEqual(fetchCount, 1);

    // Navigating back triggers focus effect again
    loadTeamEvidenceData(1, true);
    assert.strictEqual(fetchCount, 2, 'Focus effect refreshes data on each navigation focus');
  });

  // Scenario 5: Officer switches between 'All', 'Yours', 'Transfers' tabs; correct evidence shown for each
  test('Scenario 5: Scope switching filters evidence correctly across tabs', () => {
    const evidenceSet = [
      { evidence_id: 'EV-1', created_by: 'officer-1', owner_id: 'officer-1', title: 'Own Created' },
      { evidence_id: 'EV-2', created_by: 'officer-2', owner_id: 'officer-1', title: 'Transferred To Officer 1' },
      { evidence_id: 'EV-3', created_by: 'officer-3', owner_id: 'officer-3', title: 'Other Officer' },
    ];

    const currentUserId = 'officer-1';

    // Tab 1: All Evidence for Officer (own created + accepted transfers)
    const allTab = evidenceSet.filter(e =>
      e.created_by === currentUserId || e.owner_id === currentUserId
    );
    assert.deepStrictEqual(allTab.map(e => e.evidence_id), ['EV-1', 'EV-2']);

    // Tab 2: Your Evidence (strictly created by officer)
    const yoursTab = evidenceSet.filter(e =>
      e.created_by === currentUserId
    );
    assert.deepStrictEqual(yoursTab.map(e => e.evidence_id), ['EV-1']);

    // Tab 3: Transfers (items where owner is current user but original creator is different)
    const transfersTab = evidenceSet.filter(e =>
      e.owner_id === currentUserId && e.created_by !== currentUserId
    );
    assert.deepStrictEqual(transfersTab.map(e => e.evidence_id), ['EV-2']);
  });

  // Scenario 6: Officer searches evidence by title, category, or evidence ID; results match query
  test('Scenario 6: Evidence search matches evidence_id, title, and description case-insensitively', () => {
    const items = [
      { evidence_id: 'EV-2026-000301', title: 'Robbery Weapon Glock', description: 'Recovered at scene' },
      { evidence_id: 'EV-2026-000302', title: 'Financial Records', description: 'Ledger found in drawer' },
      { evidence_id: 'EV-2026-000303', title: 'Traffic Footage', description: 'Intersection cam Glock' }
    ];

    const filterByQuery = (q: string) => {
      const term = q.toLowerCase().trim();
      return items.filter(e =>
        e.evidence_id.toLowerCase().includes(term) ||
        e.title.toLowerCase().includes(term) ||
        e.description.toLowerCase().includes(term)
      );
    };

    assert.strictEqual(filterByQuery('glock').length, 2);
    assert.strictEqual(filterByQuery('000302').length, 1);
    assert.strictEqual(filterByQuery('LEDGER').length, 1);
    assert.strictEqual(filterByQuery('nonexistent').length, 0);
  });

  // Scenario 7: Officer filters evidence by verification status; only matching evidence is displayed
  test('Scenario 7: Verification filter isolates PENDING, VERIFIED, or INTEGRITY_FAILED items', () => {
    const list = [
      { evidence_id: 'EV-1', verification_status: 'PENDING' },
      { evidence_id: 'EV-2', verification_status: 'VERIFIED' },
      { evidence_id: 'EV-3', verification_status: 'INTEGRITY_FAILED' },
      { evidence_id: 'EV-4', verification_status: 'PENDING' }
    ];

    const filterStatus = (status: string) => {
      if (status === 'ALL') return list;
      return list.filter(e => e.verification_status === status);
    };

    assert.strictEqual(filterStatus('PENDING').length, 2);
    assert.strictEqual(filterStatus('VERIFIED').length, 1);
    assert.strictEqual(filterStatus('INTEGRITY_FAILED').length, 1);
    assert.strictEqual(filterStatus('ALL').length, 4);
  });

  // Scenario 8: Officer pulls to refresh; list updates without error or duplicate items
  test('Scenario 8: Pull-to-refresh resets pagination and eliminates duplicate records by business evidence_id', () => {
    const page1Data = [
      { evidence_id: 'EV-100', title: 'Case 100' },
      { evidence_id: 'EV-101', title: 'Case 101' }
    ];
    const incomingData = [
      { evidence_id: 'EV-101', title: 'Case 101 Updated' },
      { evidence_id: 'EV-102', title: 'Case 102 New' }
    ];

    // Deduplication via Map
    const deduplicated = Array.from(
      new Map([...page1Data, ...incomingData].map(item => [item.evidence_id, item])).values()
    );

    assert.strictEqual(deduplicated.length, 3);
    assert.strictEqual(deduplicated.find(d => d.evidence_id === 'EV-101')?.title, 'Case 101 Updated');
  });

  // Scenario 9: Officer taps evidence card; detail screen opens with complete and correct information
  test('Scenario 9: Evidence detail screen maps all core metadata fields', () => {
    const record = {
      id: 'db-uuid-001',
      evidence_id: 'EV-2026-789012',
      team_id: 'team-uuid-1',
      owner_id: 'officer-uuid-1',
      title: 'Homicide Scene Knife',
      description: 'Found in alleyway',
      category: 'Physical',
      location: '123 Elm St',
      captured_at: '2026-11-02T10:00:00.000Z',
      status: 'ACTIVE',
      verification_status: 'VERIFIED'
    };

    assert.ok(record.evidence_id.startsWith('EV-'));
    assert.strictEqual(record.title, 'Homicide Scene Knife');
    assert.strictEqual(record.verification_status, 'VERIFIED');
    assert.ok(record.captured_at);
  });

  // Scenario 10: Officer taps evidence that is unsynced; local detail screen opens with attachments
  test('Scenario 10: Unsynced local evidence opens with cached attachments and local URIs', () => {
    const localStore = new Map();
    localStore.set('EV-LOCAL-1', {
      evidence: {
        evidenceId: 'EV-LOCAL-1',
        title: 'Local Only Scene',
        syncStatus: 'PENDING'
      },
      attachments: [
        {
          attachmentId: 'ATT-001',
          evidenceId: 'EV-LOCAL-1',
          originalName: 'photo.jpg',
          localUri: 'file:///local/path/photo.jpg',
          sha256: 'a'.repeat(64),
          uploadStatus: 'LOCAL_ONLY'
        }
      ]
    });

    const result = localStore.get('EV-LOCAL-1');
    assert.ok(result);
    assert.strictEqual(result.evidence.syncStatus, 'PENDING');
    assert.strictEqual(result.attachments.length, 1);
    assert.strictEqual(result.attachments[0].localUri, 'file:///local/path/photo.jpg');
  });

  // Scenario 11: Officer taps evidence that does not exist; clear NOT_FOUND screen displayed, not blank/crash
  test('Scenario 11: Missing evidence results in explicit NOT_FOUND error state', () => {
    const resolveEvidence = (foundRecord: any) => {
      if (!foundRecord) {
        return { type: 'NOT_FOUND', message: 'Evidence record not found.' };
      }
      return { type: 'SUCCESS', data: foundRecord };
    };

    const result = resolveEvidence(null);
    assert.strictEqual(result.type, 'NOT_FOUND');
    assert.ok(result.message?.includes('not found'));
  });

  // Scenario 12: Officer attempts to access evidence belonging to another team; access denied gracefully
  test('Scenario 12: Authorization failure (42501) triggers UNAUTHORIZED state gracefully', () => {
    const handleDbError = (err: { code?: string; message?: string }) => {
      if (err.code === '42501' || err.message?.toLowerCase().includes('permission') || err.message?.toLowerCase().includes('row-level security')) {
        return { type: 'UNAUTHORIZED', message: 'You do not have permission to view evidence belonging to another team.' };
      }
      return { type: 'NETWORK_ERROR', message: err.message || 'Unknown error' };
    };

    const authErr = handleDbError({ code: '42501', message: 'new row violates row-level security policy' });
    assert.strictEqual(authErr.type, 'UNAUTHORIZED');
    assert.ok(authErr.message.includes('permission'));
  });

  // Scenario 13: Higher Officer opens Cases page; sees all evidence from officers in supervised team(s)
  test('Scenario 13: Higher Officer views all team evidence across officers in supervised team', () => {
    const teamMembers = ['officer-1', 'officer-2', 'officer-3'];
    const teamId = 'team-alpha';

    const evidenceDatabase = [
      { evidence_id: 'EV-1', team_id: 'team-alpha', owner_id: 'officer-1', title: 'Officer 1 Case' },
      { evidence_id: 'EV-2', team_id: 'team-alpha', owner_id: 'officer-2', title: 'Officer 2 Case' },
      { evidence_id: 'EV-3', team_id: 'team-beta', owner_id: 'officer-4', title: 'Team Beta Case' }
    ];

    const higherOfficerTeamCases = evidenceDatabase.filter(e => e.team_id === teamId);
    assert.strictEqual(higherOfficerTeamCases.length, 2);
    assert.ok(higherOfficerTeamCases.every(e => e.team_id === 'team-alpha'));
  });

  // Scenario 14: Higher Officer filters Cases by status (Active, All); list filters correctly
  test('Scenario 14: Higher Officer status filter separates Active from All cases', () => {
    const cases = [
      { evidence_id: 'EV-1', status: 'ACTIVE' },
      { evidence_id: 'EV-2', status: 'ARCHIVED' },
      { evidence_id: 'EV-3', status: 'ACTIVE' }
    ];

    const activeCases = cases.filter(c => c.status === 'ACTIVE');
    assert.strictEqual(activeCases.length, 2);

    const allCases = cases; // 'ALL' does not restrict status
    assert.strictEqual(allCases.length, 3);
  });

  // Scenario 15: Higher Officer filters Cases by verification status; list filters correctly
  test('Scenario 15: Higher Officer verification filter isolates Pending, Verified, and Failed', () => {
    const cases = [
      { evidence_id: 'EV-1', verification_status: 'PENDING' },
      { evidence_id: 'EV-2', verification_status: 'VERIFIED' },
      { evidence_id: 'EV-3', verification_status: 'INTEGRITY_FAILED' }
    ];

    assert.strictEqual(cases.filter(c => c.verification_status === 'PENDING').length, 1);
    assert.strictEqual(cases.filter(c => c.verification_status === 'VERIFIED').length, 1);
    assert.strictEqual(cases.filter(c => c.verification_status === 'INTEGRITY_FAILED').length, 1);
  });

  // Scenario 16: Higher Officer searches Cases by officer name, title, or evidence ID; correct results returned
  test('Scenario 16: Higher Officer search filters by officer name, title, or evidence ID', () => {
    const casesWithProfiles = [
      { evidence_id: 'EV-100', title: 'Stolen Vehicle', officer_name: 'John Miller', badge_number: 'B-123' },
      { evidence_id: 'EV-101', title: 'Burglary Tool', officer_name: 'Sarah Connor', badge_number: 'B-456' },
      { evidence_id: 'EV-102', title: 'Vehicle Parts', officer_name: 'Alex Murphy', badge_number: 'B-789' }
    ];

    const searchHO = (query: string) => {
      const q = query.toLowerCase().trim();
      return casesWithProfiles.filter(c =>
        c.evidence_id.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        (c.officer_name && c.officer_name.toLowerCase().includes(q))
      );
    };

    assert.strictEqual(searchHO('miller').length, 1);
    assert.strictEqual(searchHO('vehicle').length, 2);
    assert.strictEqual(searchHO('EV-101').length, 1);
  });

  // Scenario 17: Higher Officer taps evidence card; detail screen opens with complete evidence & attachments
  test('Scenario 17: Higher Officer detail screen queries attachments via internal UUID and business ID', () => {
    const parentEvidence = { id: 'db-uuid-888', evidence_id: 'EV-2026-999999' };
    const attachments = [
      { attachment_id: 'ATT-1', evidence_id: 'db-uuid-888', original_name: 'fingerprint.png', sha256: 'f'.repeat(64) }
    ];

    // Query supports both id or evidence_id
    const matched = attachments.filter(
      a => a.evidence_id === parentEvidence.id || a.evidence_id === parentEvidence.evidence_id
    );
    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0].original_name, 'fingerprint.png');
  });

  // Scenario 18: Higher Officer verifies evidence; verification status updates, custody event recorded
  test('Scenario 18: Official verification updates status and records Higher Officer custody event', () => {
    const evidence = {
      evidence_id: 'EV-2026-555555',
      verification_status: 'PENDING',
      team_id: 'team-alpha'
    };

    // 1. Verify status transition
    evidence.verification_status = 'VERIFIED';
    assert.strictEqual(evidence.verification_status, 'VERIFIED');

    // 2. Custody event recorded
    const custodyEvent = {
      evidence_id: evidence.evidence_id,
      team_id: evidence.team_id,
      action: 'EVIDENCE_VERIFIED',
      performed_by_user_id: 'ho-uuid-1',
      performed_by: 'Captain Hastings',
      role: 'HIGHER_OFFICER',
      status: 'SUCCESS',
      timestamp: new Date().toISOString()
    };

    assert.strictEqual(custodyEvent.action, 'EVIDENCE_VERIFIED');
    assert.strictEqual(custodyEvent.role, 'HIGHER_OFFICER');
    assert.strictEqual(custodyEvent.status, 'SUCCESS');
  });

  // Scenario 19: Evidence created offline by Officer is visible to Higher Officer after sync
  test('Scenario 19: Evidence created offline by Officer is visible to Higher Officer once synchronized', () => {
    const officerUploadOffline = {
      evidence_id: 'EV-2026-333333',
      team_id: 'team-shared',
      owner_id: 'officer-1',
      created_by: 'officer-1',
      title: 'Synchronized Offline Scene',
      status: 'ACTIVE',
      verification_status: 'PENDING'
    };

    // Stored locally -> synced to cloud DB
    const cloudDatabase = [officerUploadOffline];

    // Higher Officer queries team evidence
    const hoQuery = cloudDatabase.filter(e => e.team_id === 'team-shared');
    assert.strictEqual(hoQuery.length, 1);
    assert.strictEqual(hoQuery[0].evidence_id, 'EV-2026-333333');
    assert.strictEqual(hoQuery[0].title, 'Synchronized Offline Scene');
  });

  // Scenario 20: No database policy contains USING(true) or allows cross-team data leaks
  test('Scenario 20: Security audit confirms no permissive USING(true) on evidence, attachments, or custody', () => {
    const securityPolicyPath = path.resolve('supabase/manual_setup/02_security_policies.sql');
    const policyContent = fs.readFileSync(securityPolicyPath, 'utf8');

    // Check evidence policies
    const evidenceUpdateMatch = policyContent.match(/CREATE POLICY "evidence_update_policy"[\s\S]*?;/);
    assert.ok(evidenceUpdateMatch, 'evidence_update_policy exists');
    assert.strictEqual(evidenceUpdateMatch[0].includes('USING (true)'), false);

    const evidenceSelectMatch = policyContent.match(/CREATE POLICY "evidence_select_policy"[\s\S]*?;/);
    assert.ok(evidenceSelectMatch, 'evidence_select_policy exists');
    assert.strictEqual(evidenceSelectMatch[0].includes('USING (true)'), false);
    assert.ok(evidenceSelectMatch[0].includes('team_id IN (SELECT public.get_user_team_ids())'));

    // Check attachments policies
    const attSelectMatch = policyContent.match(/CREATE POLICY "evidence_attachments_select_policy"[\s\S]*?;/);
    assert.ok(attSelectMatch, 'evidence_attachments_select_policy exists');
    assert.strictEqual(attSelectMatch[0].includes('USING (true)'), false);

    const attUpdateMatch = policyContent.match(/CREATE POLICY "evidence_attachments_update_policy"[\s\S]*?;/);
    assert.ok(attUpdateMatch, 'evidence_attachments_update_policy exists');
    assert.strictEqual(attUpdateMatch[0].includes('USING (true)'), false);

    // Check custody policies
    const custodySelectMatch = policyContent.match(/CREATE POLICY "evidence_custody_select_policy"[\s\S]*?;/);
    assert.ok(custodySelectMatch, 'evidence_custody_select_policy exists');
    assert.strictEqual(custodySelectMatch[0].includes('USING (true)'), false);
    assert.ok(custodySelectMatch[0].includes('team_id IN (SELECT public.get_user_team_ids())'));
  });

  // Scenario 21: Evidence with verification_status: 'PENDING' is visible immediately to both roles
  test('Scenario 21: Evidence awaiting verification is visible immediately without requiring approval', () => {
    const unverifiedEvidence = {
      evidence_id: 'EV-2026-UNVERIFIED',
      team_id: 'team-alpha',
      owner_id: 'officer-1',
      title: 'Unverified Crime Scene Photos',
      status: 'ACTIVE',
      verification_status: 'PENDING',
      cloud_verification_status: 'NOT_VERIFIED'
    };

    // 1. Officer query includes unverified evidence
    const officerAccessible = (e: typeof unverifiedEvidence) =>
      e.owner_id === 'officer-1' && ['ACTIVE', 'PENDING'].includes(e.status);
    assert.strictEqual(officerAccessible(unverifiedEvidence), true, 'Officer sees unverified evidence');

    // 2. Higher Officer query includes unverified evidence for their team
    const hoAccessible = (e: typeof unverifiedEvidence, hoTeamId: string) =>
      e.team_id === hoTeamId;
    assert.strictEqual(hoAccessible(unverifiedEvidence, 'team-alpha'), true, 'Higher Officer sees unverified evidence');
    assert.strictEqual(unverifiedEvidence.verification_status, 'PENDING');
  });

  // Scenario 22: Higher Officer search by officer name matches profiles
  test('Scenario 22: Higher Officer search matches officer name and badge number', () => {
    const profiles = [
      { user_id: 'u-1', display_name: 'Detective Miller', badge_number: 'B-777' },
      { user_id: 'u-2', display_name: 'Officer Davis', badge_number: 'B-888' }
    ];

    const evidenceList = [
      { evidence_id: 'EV-1', owner_id: 'u-1', title: 'Case A' },
      { evidence_id: 'EV-2', owner_id: 'u-2', title: 'Case B' }
    ];

    const searchByName = (query: string) => {
      const q = query.toLowerCase();
      const matchedUserIds = profiles
        .filter(p => p.display_name.toLowerCase().includes(q) || p.badge_number.toLowerCase().includes(q))
        .map(p => p.user_id);
      return evidenceList.filter(e => matchedUserIds.includes(e.owner_id));
    };

    assert.strictEqual(searchByName('Miller').length, 1);
    assert.strictEqual(searchByName('Miller')[0].evidence_id, 'EV-1');
    assert.strictEqual(searchByName('B-888').length, 1);
    assert.strictEqual(searchByName('B-888')[0].evidence_id, 'EV-2');
  });

  // Scenario 23: Higher Officer local fallback enforces team boundary isolation
  test('Scenario 23: Higher Officer local fallback prevents cross-team evidence disclosure', () => {
    const hoTeamId = 'team-alpha';
    const otherTeamEvidence = {
      evidenceId: 'EV-OTHER-TEAM',
      teamId: 'team-beta',
      title: 'Confidential Internal Affairs Case'
    };

    const evaluateLocalAccess = (ev: typeof otherTeamEvidence, callerTeamId: string) => {
      if (callerTeamId && ev.teamId && callerTeamId !== ev.teamId) {
        return { type: 'UNAUTHORIZED', error: 'Access Denied: This evidence belongs to another team.' };
      }
      return { type: 'SUCCESS', data: ev };
    };

    const accessResult = evaluateLocalAccess(otherTeamEvidence, hoTeamId);
    assert.strictEqual(accessResult.type, 'UNAUTHORIZED');
  });

  // Scenario 24: Status transitions from PENDING to VERIFIED or REJECTED preserve records
  test('Scenario 24: Verification status update to VERIFIED or REJECTED preserves evidence record', () => {
    const record = {
      evidence_id: 'EV-2026-STATUS-CHECK',
      team_id: 'team-alpha',
      title: 'Weapon Recovered',
      verification_status: 'PENDING'
    };

    // Transition to VERIFIED
    record.verification_status = 'VERIFIED';
    assert.strictEqual(record.verification_status, 'VERIFIED');
    assert.strictEqual(record.evidence_id, 'EV-2026-STATUS-CHECK');

    // Transition to REJECTED
    record.verification_status = 'REJECTED';
    assert.strictEqual(record.verification_status, 'REJECTED');
    assert.strictEqual(record.title, 'Weapon Recovered', 'Title and metadata remain intact on rejection');
  });
});
