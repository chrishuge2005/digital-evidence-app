import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

// ============================================================================
// INVITATION & TEAM MEMBERSHIP WORKFLOW TESTS
// ============================================================================

describe('Officer Invitation Validation & Formatting', () => {
  const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  const validateInvitationInput = (name: string, email: string) => {
    const cleanName = name ? name.trim() : '';
    const cleanEmail = email ? email.trim().toLowerCase() : '';

    if (!cleanName) {
      throw new Error('Officer full name is required.');
    }
    if (cleanName.length > 100) {
      throw new Error('Officer name must be 100 characters or less.');
    }
    if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) {
      throw new Error(`Invalid email format: "${cleanEmail}".`);
    }

    return { cleanName, cleanEmail };
  };

  test('Valid name and email are trimmed and normalized', () => {
    const res = validateInvitationInput('  Officer Sarah Connor  ', '  Sarah.Connor@Department.Gov ');
    assert.strictEqual(res.cleanName, 'Officer Sarah Connor');
    assert.strictEqual(res.cleanEmail, 'sarah.connor@department.gov');
  });

  test('Empty or whitespace name is rejected', () => {
    assert.throws(() => validateInvitationInput('', 'officer@dept.gov'), /Officer full name is required/);
    assert.throws(() => validateInvitationInput('   ', 'officer@dept.gov'), /Officer full name is required/);
  });

  test('Name exceeding 100 characters is rejected', () => {
    const longName = 'A'.repeat(101);
    assert.throws(() => validateInvitationInput(longName, 'officer@dept.gov'), /100 characters or less/);
  });

  test('Malformed emails are rejected', () => {
    assert.throws(() => validateInvitationInput('Officer', 'not-an-email'), /Invalid email format/);
    assert.throws(() => validateInvitationInput('Officer', 'missing@domain'), /Invalid email format/);
    assert.throws(() => validateInvitationInput('Officer', '@nodomain.com'), /Invalid email format/);
    assert.throws(() => validateInvitationInput('Officer', 'spaces in@mail.com'), /Invalid email format/);
  });
});

describe('Token Hashing & Acceptance Security', () => {
  const hashTokenNode = (token: string): string => {
    return createHash('sha256').update(token.trim()).digest('hex');
  };

  test('SHA-256 token hashing produces deterministic 64-character hex strings', () => {
    const rawToken = '4f8b9e2a1c7d5f0e3b6a9c8d7e4f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
    const hash1 = hashTokenNode(rawToken);
    const hash2 = hashTokenNode(rawToken);

    assert.strictEqual(hash1.length, 64);
    assert.strictEqual(/^[0-9a-f]{64}$/.test(hash1), true);
    assert.strictEqual(hash1, hash2);
  });

  test('Different tokens generate distinct hashes', () => {
    const tokenA = 'token_alpha_12345';
    const tokenB = 'token_beta_67890';
    assert.notStrictEqual(hashTokenNode(tokenA), hashTokenNode(tokenB));
  });

  test('Invitation status lifecycle rejects expired, revoked, or already accepted invitations', () => {
    const checkInvitationStatus = (invitation: {
      status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
      expiresAt: Date;
    }) => {
      const now = new Date();
      if (invitation.status === 'ACCEPTED') throw new Error('Already accepted');
      if (invitation.status === 'REVOKED') throw new Error('Revoked');
      if (invitation.status === 'EXPIRED' || invitation.expiresAt < now) throw new Error('Expired');
      return true;
    };

    const futureDate = new Date(Date.now() + 86400000);
    const pastDate = new Date(Date.now() - 86400000);

    // Valid pending
    assert.strictEqual(checkInvitationStatus({ status: 'PENDING', expiresAt: futureDate }), true);

    // Accepted
    assert.throws(
      () => checkInvitationStatus({ status: 'ACCEPTED', expiresAt: futureDate }),
      /Already accepted/
    );

    // Revoked
    assert.throws(
      () => checkInvitationStatus({ status: 'REVOKED', expiresAt: futureDate }),
      /Revoked/
    );

    // Expired by status
    assert.throws(
      () => checkInvitationStatus({ status: 'EXPIRED', expiresAt: futureDate }),
      /Expired/
    );

    // Expired by timestamp
    assert.throws(
      () => checkInvitationStatus({ status: 'PENDING', expiresAt: pastDate }),
      /Expired/
    );
  });
});

describe('Identity Verification & Authorization Boundaries', () => {
  test('Acceptance requires caller verified email to match invitation email strictly', () => {
    const verifyIdentityMatch = (callerEmail: string, invitationEmail: string) => {
      const c = callerEmail.trim().toLowerCase();
      const i = invitationEmail.trim().toLowerCase();
      if (c !== i) {
        throw new Error(`Account mismatch: invited "${i}", signed in as "${c}".`);
      }
      return true;
    };

    assert.strictEqual(
      verifyIdentityMatch('officer@dept.gov', 'OFFICER@dept.gov'),
      true
    );

    assert.throws(
      () => verifyIdentityMatch('attacker@dept.gov', 'victim@dept.gov'),
      /Account mismatch/
    );
  });

  test('Higher Officer cannot join a team as an ordinary officer', () => {
    const checkRoleEligibilityForOfficerMembership = (callerRole: string) => {
      if (callerRole === 'HIGHER_OFFICER') {
        throw new Error('A Higher Officer account cannot join a team as an ordinary officer.');
      }
      return true;
    };

    assert.strictEqual(checkRoleEligibilityForOfficerMembership('OFFICER'), true);
    assert.throws(
      () => checkRoleEligibilityForOfficerMembership('HIGHER_OFFICER'),
      /A Higher Officer account cannot join/
    );
  });

  test('Officer already active in another team cannot accept without transfer', () => {
    const checkCrossTeamActiveMembership = (currentTeamId: string | null, targetTeamId: string) => {
      if (currentTeamId && currentTeamId !== targetTeamId) {
        throw new Error('Officer is already an active member of another team.');
      }
      return true;
    };

    assert.strictEqual(checkCrossTeamActiveMembership(null, 'team-123'), true);
    assert.strictEqual(checkCrossTeamActiveMembership('team-123', 'team-123'), true);
    assert.throws(
      () => checkCrossTeamActiveMembership('team-456', 'team-123'),
      /already an active member of another team/
    );
  });
});

describe('In-App Notification & Discovery Workflow', () => {
  test('Discovers pending invitation only when authenticated user email matches invitation email', () => {
    const filterInvitationsForOfficer = (
      invitations: Array<{ id: string; email: string; status: string; expiresAt: Date }>,
      officerEmail: string
    ) => {
      const normalizedOfficerEmail = officerEmail.trim().toLowerCase();
      const now = new Date();
      return invitations.filter(
        (inv) =>
          inv.email.trim().toLowerCase() === normalizedOfficerEmail &&
          inv.status === 'PENDING' &&
          inv.expiresAt > now
      );
    };

    const futureDate = new Date(Date.now() + 86400000);
    const mockInvites = [
      { id: '1', email: 'officer.smith@dept.gov', status: 'PENDING', expiresAt: futureDate },
      { id: '2', email: 'officer.jones@dept.gov', status: 'PENDING', expiresAt: futureDate },
      { id: '3', email: 'officer.smith@dept.gov', status: 'ACCEPTED', expiresAt: futureDate },
    ];

    const smithInvites = filterInvitationsForOfficer(mockInvites, 'Officer.Smith@dept.gov');
    assert.strictEqual(smithInvites.length, 1);
    assert.strictEqual(smithInvites[0].id, '1');

    const jonesInvites = filterInvitationsForOfficer(mockInvites, 'officer.jones@dept.gov');
    assert.strictEqual(jonesInvites.length, 1);
    assert.strictEqual(jonesInvites[0].id, '2');

    const unrelatedInvites = filterInvitationsForOfficer(mockInvites, 'unrelated@dept.gov');
    assert.strictEqual(unrelatedInvites.length, 0);
  });

  test('Marks notification read and prevents repeated acceptance', () => {
    let invitationStatus = 'PENDING';
    let notificationIsRead = false;

    const acceptInvitation = () => {
      if (invitationStatus === 'ACCEPTED') {
        throw new Error('This invitation has already been accepted.');
      }
      invitationStatus = 'ACCEPTED';
      notificationIsRead = true;
      return { success: true };
    };

    const result = acceptInvitation();
    assert.strictEqual(result.success, true);
    assert.strictEqual(invitationStatus, 'ACCEPTED');
    assert.strictEqual(notificationIsRead, true);

    // Second acceptance must be blocked
    assert.throws(() => acceptInvitation(), /This invitation has already been accepted/);
  });
});
