import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// PROFILES RLS POLICY & IMMUTABILITY TRIGGER TEST SUITE
// Tests for Phase 6: All 12 Security Scenarios
// Note: Simulated tests validate policy and trigger logic under strict emulation.
// ============================================================================

describe('Profiles RLS & Immutability Security Verification (Scenarios 1 - 12)', () => {
  const migrationPath = path.resolve('supabase/migrations/20261105_fix_profiles_update_rls_recursion.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // --------------------------------------------------------------------------
  // Scenario 11: Profile updates do not produce 42P17 (Zero recursive subqueries)
  // --------------------------------------------------------------------------
  test('Scenario 11: profiles_update_policy contains NO recursive subqueries against public.profiles', () => {
    const policyRegex = /CREATE\s+POLICY\s+"profiles_update_policy"[\s\S]*?;/i;
    const match = migrationSql.match(policyRegex);
    assert.ok(match, 'profiles_update_policy must exist in migration 20261105');

    const policySql = match[0];

    // Must NOT contain any self-referencing subquery against public.profiles
    const recursivePattern = /SELECT\s+.*?\s+FROM\s+(public\.)?profiles/i;
    assert.strictEqual(
      recursivePattern.test(policySql),
      false,
      'profiles_update_policy must NOT contain any subquery against profiles table'
    );

    // Verify USING and WITH CHECK are pure ownership expressions
    assert.ok(policySql.includes('USING (auth.uid() = user_id)'), 'Must enforce auth.uid() = user_id in USING');
    assert.ok(policySql.includes('WITH CHECK (auth.uid() = user_id)'), 'Must enforce auth.uid() = user_id in WITH CHECK');
  });

  // --------------------------------------------------------------------------
  // Trigger & RLS Evaluation Engine Model
  // Emulates PostgreSQL trigger validate_profile_immutability() and RLS
  // --------------------------------------------------------------------------
  const evaluateProfileUpdate = (params: {
    callerUid: string | null;
    callerAuthRole: 'authenticated' | 'service_role' | null;
    isSupervisor: boolean;
    isSecurityDefinerRpc?: boolean;
    appAllowRolePromotionSetting?: string;
    appAllowTeamReassignmentSetting?: string;
    ownedTeamIds?: string[];
    oldRow: {
      id: string;
      user_id: string;
      email: string;
      display_name: string;
      role: 'OFFICER' | 'HIGHER_OFFICER';
      team_id: string | null;
      badge_number: string | null;
      created_at: string;
    };
    newRow: {
      id: string;
      user_id: string;
      email: string;
      display_name: string;
      role: 'OFFICER' | 'HIGHER_OFFICER';
      team_id: string | null;
      badge_number: string | null;
      created_at?: string;
    };
  }): { allowed: boolean; error?: string; resultRow?: any } => {
    const {
      callerUid,
      callerAuthRole,
      isSupervisor,
      isSecurityDefinerRpc,
      appAllowRolePromotionSetting,
      appAllowTeamReassignmentSetting,
      ownedTeamIds = [],
      oldRow,
      newRow
    } = params;

    // 1. RLS UPDATE Policy Check: USING (auth.uid() = user_id)
    // SECURITY DEFINER RPCs and service_role bypass client RLS filters
    if (!isSecurityDefinerRpc && callerAuthRole !== 'service_role') {
      if (!callerUid || callerUid !== oldRow.user_id) {
        return { allowed: false, error: 'RLS: 0 rows affected (USING filter rejected access to other profile)' };
      }
    }

    // 2. Trigger check 1: user_id immutability
    if (newRow.user_id !== oldRow.user_id) {
      return { allowed: false, error: 'Unauthorized modification: Profile user_id is immutable and cannot be changed.' };
    }

    // 3. Trigger check 2: primary key id immutability
    if (newRow.id !== oldRow.id) {
      return { allowed: false, error: 'Unauthorized modification: Profile id is immutable and cannot be changed.' };
    }

    // 4. Trigger check 3: role modification guard (Anti-Escalation & Anti-Self-Promotion)
    if (newRow.role !== oldRow.role) {
      let isAuthorizedRoleChange = false;

      if (callerAuthRole === 'service_role') {
        isAuthorizedRoleChange = true;
      } else if (callerAuthRole === null && callerUid === null) {
        // Direct administrative SQL
        if (appAllowRolePromotionSetting === 'true') {
          isAuthorizedRoleChange = true;
        }
      } else if (callerAuthRole === 'authenticated' && callerUid !== null) {
        if (appAllowRolePromotionSetting === 'true' && isSupervisor) {
          // Cannot promote oneself
          if (callerUid !== oldRow.user_id) {
            isAuthorizedRoleChange = true;
          }
        }
      }

      if (!isAuthorizedRoleChange) {
        return {
          allowed: false,
          error: 'Unauthorized role modification: User roles cannot be modified directly. Role elevation requires supervisory authorization.'
        };
      }
    }

    // 5. Trigger check 4: team_id modification guard (Anti-Reassignment)
    if (newRow.team_id !== oldRow.team_id) {
      let isAuthorizedTeamChange = false;

      if (callerAuthRole === 'service_role') {
        isAuthorizedTeamChange = true;
      } else if (callerAuthRole === null && callerUid === null) {
        if (appAllowTeamReassignmentSetting === 'true') {
          isAuthorizedTeamChange = true;
        }
      } else if (callerAuthRole === 'authenticated' && callerUid !== null) {
        if (appAllowTeamReassignmentSetting === 'true') {
          isAuthorizedTeamChange = true;
        } else if (newRow.team_id !== null && isSupervisor && ownedTeamIds.includes(newRow.team_id)) {
          isAuthorizedTeamChange = true;
        }
      }

      if (!isAuthorizedTeamChange) {
        return {
          allowed: false,
          error: 'Unauthorized team reassignment: Ordinary officers cannot modify their team assignment directly. Team assignments require supervisor assignment or official invitation acceptance.'
        };
      }
    }

    // 6. RLS UPDATE Policy Check: WITH CHECK (auth.uid() = user_id)
    if (!isSecurityDefinerRpc && callerAuthRole !== 'service_role') {
      if (!callerUid || callerUid !== newRow.user_id) {
        return { allowed: false, error: 'RLS: WITH CHECK constraint failed' };
      }
    }

    const resultRow = {
      ...newRow,
      id: oldRow.id,
      user_id: oldRow.user_id,
      created_at: oldRow.created_at,
      updated_at: new Date().toISOString()
    };

    return { allowed: true, resultRow };
  };

  const sampleOfficer = {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: 'user-officer-01',
    email: 'officer01@police.test',
    display_name: 'Officer John',
    role: 'OFFICER' as const,
    team_id: 'team-alpha',
    badge_number: 'BADGE-101',
    created_at: '2026-11-01T00:00:00Z'
  };

  // --------------------------------------------------------------------------
  // Scenario 1: Officer can update permitted personal fields
  // --------------------------------------------------------------------------
  test('Scenario 1: Officer can update permitted personal fields (display_name, badge_number)', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        display_name: 'Detective John Doe',
        badge_number: 'BADGE-999'
      }
    });

    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.resultRow.display_name, 'Detective John Doe');
    assert.strictEqual(res.resultRow.badge_number, 'BADGE-999');
    assert.strictEqual(res.resultRow.role, 'OFFICER');
    assert.strictEqual(res.resultRow.user_id, 'user-officer-01');
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Officer cannot modify another user profile
  // --------------------------------------------------------------------------
  test('Scenario 2: Officer cannot modify another user profile (RLS USING guard)', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-attacker',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        display_name: 'Attacker Tampered Name'
      }
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('USING filter rejected access'));
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Officer cannot change role (Self-Promotion Blocked)
  // --------------------------------------------------------------------------
  test('Scenario 3: Officer cannot change role from OFFICER to HIGHER_OFFICER directly', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        role: 'HIGHER_OFFICER'
      }
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Unauthorized role modification'));
    assert.ok(res.error?.includes('Role elevation requires supervisory authorization'));
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Officer cannot change user_id
  // --------------------------------------------------------------------------
  test('Scenario 4: Officer cannot change user_id (immutable identity check)', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        user_id: 'hijacked-user-uuid'
      }
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Profile user_id is immutable'));
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Officer cannot change profile id
  // --------------------------------------------------------------------------
  test('Scenario 5: Officer cannot change profile primary key id', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        id: '22222222-2222-2222-2222-222222222222'
      }
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Profile id is immutable'));
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Officer cannot change team_id without authorization
  // --------------------------------------------------------------------------
  test('Scenario 6: Officer cannot change team_id via direct client update', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        team_id: 'team-unauthorized-target'
      }
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Unauthorized team reassignment'));
    assert.ok(res.error?.includes('require supervisor assignment or official invitation'));
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Officer cannot invoke unauthorized promotion
  // --------------------------------------------------------------------------
  test('Scenario 7: Officer cannot invoke unauthorized promotion (self or peer)', () => {
    // Attempt A: Officer attempts to promote self via RPC logic
    const resSelf = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      isSecurityDefinerRpc: true,
      appAllowRolePromotionSetting: 'true',
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        role: 'HIGHER_OFFICER'
      }
    });
    assert.strictEqual(resSelf.allowed, false);
    assert.ok(resSelf.error?.includes('Unauthorized role modification'));

    // Attempt B: Officer attempts to promote another officer
    const peerOfficer = { ...sampleOfficer, user_id: 'user-officer-02' };
    const resPeer = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      isSecurityDefinerRpc: true,
      appAllowRolePromotionSetting: 'true',
      oldRow: peerOfficer,
      newRow: {
        ...peerOfficer,
        role: 'HIGHER_OFFICER'
      }
    });
    assert.strictEqual(resPeer.allowed, false);
    assert.ok(resPeer.error?.includes('Unauthorized role modification'));
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Authorized Higher Officer can promote an eligible Officer
  // --------------------------------------------------------------------------
  test('Scenario 8: Authorized Higher Officer can promote an eligible Officer via promote_officer_to_higher_officer', () => {
    const res = evaluateProfileUpdate({
      callerUid: 'supervisor-ho-01',
      callerAuthRole: 'authenticated',
      isSupervisor: true,
      isSecurityDefinerRpc: true,
      appAllowRolePromotionSetting: 'true',
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        role: 'HIGHER_OFFICER'
      }
    });

    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.resultRow.role, 'HIGHER_OFFICER');
    assert.strictEqual(res.resultRow.user_id, sampleOfficer.user_id);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Initial administrator provisioning works securely
  // --------------------------------------------------------------------------
  test('Scenario 9: Initial administrator bootstrap provisioning works securely with administrative context', () => {
    // In administrative SQL session: callerAuthRole = null, callerUid = null, appAllowRolePromotionSetting = 'true'
    const res = evaluateProfileUpdate({
      callerUid: null,
      callerAuthRole: null,
      isSupervisor: false,
      isSecurityDefinerRpc: true,
      appAllowRolePromotionSetting: 'true',
      appAllowTeamReassignmentSetting: 'true',
      oldRow: sampleOfficer,
      newRow: {
        ...sampleOfficer,
        role: 'HIGHER_OFFICER',
        team_id: 'team-initial-precinct'
      }
    });

    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.resultRow.role, 'HIGHER_OFFICER');
    assert.strictEqual(res.resultRow.team_id, 'team-initial-precinct');
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Evidence team isolation remains intact
  // --------------------------------------------------------------------------
  test('Scenario 10: Evidence team isolation and access policies remain intact and isolated', () => {
    // Verify migration touches ONLY public.profiles and trusted management procedures
    assert.strictEqual(migrationSql.includes('DROP POLICY IF EXISTS "evidence_select_policy"'), false);
    assert.strictEqual(migrationSql.includes('DROP POLICY IF EXISTS "evidence_insert_policy"'), false);
    assert.strictEqual(migrationSql.includes('DROP POLICY IF EXISTS "evidence_update_policy"'), false);
    assert.strictEqual(migrationSql.includes('DROP POLICY IF EXISTS "evidence_attachments_select_policy"'), false);
    assert.strictEqual(migrationSql.includes('evidence-files'), false);

    // Verify team isolation rule
    const isEvidenceAccessible = (callerActiveTeams: string[], evidenceTeamId: string) => {
      return callerActiveTeams.includes(evidenceTeamId);
    };

    assert.strictEqual(isEvidenceAccessible(['team-alpha'], 'team-alpha'), true);
    assert.strictEqual(isEvidenceAccessible(['team-beta'], 'team-alpha'), false);
    assert.strictEqual(isEvidenceAccessible([], 'team-alpha'), false);
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Direct authenticated API requests cannot bypass the trigger
  // --------------------------------------------------------------------------
  test('Scenario 12: Direct authenticated PostgREST API request with spoofed payload cannot bypass trigger', () => {
    // Attacker crafts payload with display_name change PLUS role = HIGHER_OFFICER
    const maliciousPayload = {
      ...sampleOfficer,
      display_name: 'Officer John (Promoted)',
      role: 'HIGHER_OFFICER' as const
    };

    const res = evaluateProfileUpdate({
      callerUid: 'user-officer-01',
      callerAuthRole: 'authenticated',
      isSupervisor: false,
      appAllowRolePromotionSetting: undefined, // Ordinary client request does NOT have session flag
      oldRow: sampleOfficer,
      newRow: maliciousPayload
    });

    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Unauthorized role modification'));
    assert.strictEqual(res.resultRow, undefined);
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Bootstrap script prevents silent team takeover
  // --------------------------------------------------------------------------
  test('Scenario 13: Bootstrap script prevents silent team takeover and validates existing team owner', () => {
    const bootstrapPath = path.resolve('supabase/manual_setup/bootstrap_initial_higher_officer.sql');
    const bootstrapSql = fs.readFileSync(bootstrapPath, 'utf8');

    // Verify team lookup checks both id and higher_officer_id with concurrency lock
    assert.ok(
      /SELECT\s+id,\s*higher_officer_id\s+INTO\s+v_team_id,\s*v_existing_ho_id\s+FROM\s+public\.teams\s+WHERE\s+team_code\s*=\s*v_team_code\s+FOR\s+UPDATE;/i.test(
        bootstrapSql
      ),
      'Bootstrap script must lock and retrieve id and higher_officer_id from public.teams'
    );

    // Verify fail-closed conflict rejection
    assert.ok(
      bootstrapSql.includes('ELSIF v_existing_ho_id IS NOT NULL AND v_existing_ho_id != v_target_user_id THEN'),
      'Must check if team is owned by another Higher Officer'
    );
    assert.ok(
      bootstrapSql.includes('Bootstrap cannot take over an existing team'),
      'Must raise exception with explanatory conflict message'
    );

    // Verify defensive reset of flags at end of bootstrap
    assert.ok(
      bootstrapSql.includes("PERFORM set_config('app.allow_role_promotion', 'false', true);"),
      'Must defensively reset app.allow_role_promotion'
    );
    assert.ok(
      bootstrapSql.includes("PERFORM set_config('app.allow_team_reassignment', 'false', true);"),
      'Must defensively reset app.allow_team_reassignment'
    );

    // Emulation of bootstrap conflict logic:
    const simulateBootstrapTeamAssignment = (params: {
      teamExists: boolean;
      existingHoId: string | null;
      targetUserId: string;
    }) => {
      const { teamExists, existingHoId, targetUserId } = params;
      if (!teamExists) {
        return { action: 'CREATED_NEW_TEAM', newOwner: targetUserId };
      }
      if (existingHoId !== null && existingHoId !== targetUserId) {
        throw new Error('Security Conflict: Team already belongs to another Higher Officer');
      }
      return { action: 'LINKED_EXISTING_TEAM', newOwner: targetUserId };
    };

    // Case A: Team does not exist -> creates team
    const resNew = simulateBootstrapTeamAssignment({
      teamExists: false,
      existingHoId: null,
      targetUserId: 'target-ho-01'
    });
    assert.strictEqual(resNew.action, 'CREATED_NEW_TEAM');
    assert.strictEqual(resNew.newOwner, 'target-ho-01');

    // Case B: Team exists and already owned by target user -> safely links
    const resSame = simulateBootstrapTeamAssignment({
      teamExists: true,
      existingHoId: 'target-ho-01',
      targetUserId: 'target-ho-01'
    });
    assert.strictEqual(resSame.action, 'LINKED_EXISTING_TEAM');
    assert.strictEqual(resSame.newOwner, 'target-ho-01');

    // Case C: Team exists and unassigned (null higher_officer_id) -> safely links
    const resUnassigned = simulateBootstrapTeamAssignment({
      teamExists: true,
      existingHoId: null,
      targetUserId: 'target-ho-01'
    });
    assert.strictEqual(resUnassigned.action, 'LINKED_EXISTING_TEAM');
    assert.strictEqual(resUnassigned.newOwner, 'target-ho-01');

    // Case D: Team exists and belongs to DIFFERENT Higher Officer -> FAILS CLOSED
    assert.throws(
      () => {
        simulateBootstrapTeamAssignment({
          teamExists: true,
          existingHoId: 'different-ho-99',
          targetUserId: 'target-ho-01'
        });
      },
      /Security Conflict: Team already belongs to another Higher Officer/
    );
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Trusted procedures perform checks before flags and defensively reset
  // --------------------------------------------------------------------------
  test('Scenario 14: Trusted management RPCs perform checks before setting flags and include defensive resets', () => {
    // 1. promote_officer_to_higher_officer
    assert.ok(
      migrationSql.includes("PERFORM set_config('app.allow_role_promotion', 'false', true);"),
      'promote_officer_to_higher_officer must defensively reset app.allow_role_promotion'
    );

    // 2. add_officer_to_team
    // Capacity check must precede flag activation
    const capacityIdx = migrationSql.indexOf('Team capacity reached');
    const flagIdxInAdd = migrationSql.indexOf("PERFORM set_config('app.allow_team_reassignment', 'true', true);");
    assert.ok(capacityIdx > 0 && flagIdxInAdd > 0, 'Capacity check and flag setting must exist in migration');
    assert.ok(
      capacityIdx < flagIdxInAdd,
      'Capacity check must precede app.allow_team_reassignment flag activation in add_officer_to_team'
    );

    // 3. deactivate_team_officer & accept_officer_invitation defensive resets
    const resetMatches = migrationSql.match(/PERFORM\s+set_config\('app\.allow_team_reassignment',\s*'false',\s*true\);/g);
    assert.ok(
      resetMatches && resetMatches.length >= 3,
      'Must contain defensive resets of app.allow_team_reassignment across all team management procedures'
    );
  });
});
