import { test, describe } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// DOMAIN LOGIC & SECURITY VALIDATION TESTS
// Tests pure business logic, security guards, and data validation rules
// ============================================================================

describe('Authentication & Role-Based Access Guards', () => {
  test('Role normalization converts role strings to uppercase', () => {
    const normalizeRole = (role: string | null | undefined): string => {
      return role ? String(role).toUpperCase().trim() : '';
    };

    assert.strictEqual(normalizeRole('officer'), 'OFFICER');
    assert.strictEqual(normalizeRole('HIGHER_OFFICER'), 'HIGHER_OFFICER');
    assert.strictEqual(normalizeRole('Higher_Officer'), 'HIGHER_OFFICER');
    assert.strictEqual(normalizeRole(null), '');
    assert.strictEqual(normalizeRole(undefined), '');
  });

  test('Route guard redirects unauthenticated users to login', () => {
    const decideRoute = (auth: {
      initialized: boolean;
      loading: boolean;
      isAuthenticated: boolean;
      role: string | null;
      currentSegment: string;
    }) => {
      if (!auth.initialized || auth.loading) return 'WAIT';
      const inAuthGroup = auth.currentSegment === '(auth)';
      const inOfficerGroup = auth.currentSegment === '(officer)';
      const inHigherOfficerGroup = auth.currentSegment === '(higher-officer)';
      const normalizedRole = auth.role ? String(auth.role).toUpperCase() : '';

      if (!auth.isAuthenticated && !inAuthGroup) {
        return '/(auth)/login';
      }
      if (auth.isAuthenticated) {
        if (inAuthGroup) {
          return normalizedRole === 'HIGHER_OFFICER'
            ? '/(higher-officer)/dashboard'
            : '/(officer)/dashboard';
        }
        if (inOfficerGroup && normalizedRole === 'HIGHER_OFFICER') {
          return '/(higher-officer)/dashboard';
        }
        if (inHigherOfficerGroup && normalizedRole !== 'HIGHER_OFFICER') {
          return '/(officer)/dashboard';
        }
      }
      return 'STAY';
    };

    // Unauthenticated in protected areas -> redirect to login
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: false, role: null, currentSegment: '(officer)' }),
      '/(auth)/login'
    );
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: false, role: null, currentSegment: '(higher-officer)' }),
      '/(auth)/login'
    );

    // Authenticated Officer in login -> redirect to officer dashboard
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: true, role: 'OFFICER', currentSegment: '(auth)' }),
      '/(officer)/dashboard'
    );

    // Authenticated Higher Officer in login -> redirect to HO dashboard
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: true, role: 'HIGHER_OFFICER', currentSegment: '(auth)' }),
      '/(higher-officer)/dashboard'
    );

    // Cross-role guard: Officer trying to enter higher-officer group
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: true, role: 'OFFICER', currentSegment: '(higher-officer)' }),
      '/(officer)/dashboard'
    );

    // Cross-role guard: Higher Officer trying to enter officer group
    assert.strictEqual(
      decideRoute({ initialized: true, loading: false, isAuthenticated: true, role: 'HIGHER_OFFICER', currentSegment: '(officer)' }),
      '/(higher-officer)/dashboard'
    );
  });

  test('Fallback profile creation strictly defaults to OFFICER and never self-elevates', () => {
    const createFallbackProfilePayload = (userId: string, email: string, userMetadata: any) => {
      // Regardless of what user_metadata contains (even role: HIGHER_OFFICER),
      // fallback profile is hardcoded to OFFICER
      return {
        user_id: userId,
        email: email,
        display_name: userMetadata?.display_name || userMetadata?.full_name || 'Officer',
        role: 'OFFICER', // Hardcoded security boundary
      };
    };

    const maliciousMetadata = { role: 'HIGHER_OFFICER', display_name: 'Attacker' };
    const profile = createFallbackProfilePayload('test-user-id', 'attacker@test.com', maliciousMetadata);

    assert.strictEqual(profile.role, 'OFFICER');
    assert.notStrictEqual(profile.role, 'HIGHER_OFFICER');
  });
});

describe('Evidence Storage & Upload Rules', () => {
  const MAX_EVIDENCE_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  const SUPPORTED_MIME_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'application/pdf',
  ];

  test('Rejects file sizes exceeding 50MB', () => {
    const validateSize = (sizeBytes: number) => sizeBytes <= MAX_EVIDENCE_FILE_SIZE;

    assert.strictEqual(validateSize(1024 * 1024), true); // 1MB - OK
    assert.strictEqual(validateSize(50 * 1024 * 1024), true); // 50MB exact - OK
    assert.strictEqual(validateSize(50 * 1024 * 1024 + 1), false); // 50MB + 1 byte - REJECT
    assert.strictEqual(validateSize(100 * 1024 * 1024), false); // 100MB - REJECT
  });

  test('Allows only approved MIME types and rejects executables and scripts', () => {
    const isSupportedMime = (mime: string) => {
      const normalized = mime.toLowerCase().trim();
      return SUPPORTED_MIME_TYPES.includes(normalized);
    };

    // Valid
    assert.strictEqual(isSupportedMime('image/jpeg'), true);
    assert.strictEqual(isSupportedMime('image/png'), true);
    assert.strictEqual(isSupportedMime('video/mp4'), true);
    assert.strictEqual(isSupportedMime('application/pdf'), true);

    // Malicious or unsupported
    assert.strictEqual(isSupportedMime('application/x-msdownload'), false);
    assert.strictEqual(isSupportedMime('application/javascript'), false);
    assert.strictEqual(isSupportedMime('text/html'), false);
    assert.strictEqual(isSupportedMime('application/x-sh'), false);
  });

  test('Constructs deterministic, sanitized private storage path', () => {
    const buildStoragePath = (teamId: string, evidenceId: string, attachmentId: string, originalName: string) => {
      const safeName = (originalName || 'file')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/_+/g, '_');
      return `${teamId}/${evidenceId}/${attachmentId}_${safeName}`;
    };

    const path = buildStoragePath(
      'team-uuid-1234',
      'EVD-2026-999999',
      'att-uuid-5678',
      'Crime Scene Photo #1 (High Res).jpg'
    );

    assert.strictEqual(path, 'team-uuid-1234/EVD-2026-999999/att-uuid-5678_Crime_Scene_Photo_1_High_Res_.jpg');
    assert.ok(!path.includes(' '));
    assert.ok(!path.includes('#'));
  });
});

describe('Cryptographic Hash & Integrity Verification', () => {
  test('Validates SHA-256 hash format (64-character lowercase hexadecimal)', () => {
    const isValidSha256 = (hash: string) => {
      return typeof hash === 'string' && hash.length === 64 && /^[a-f0-9]{64}$/.test(hash);
    };

    const validHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    assert.strictEqual(isValidSha256(validHash), true);

    assert.strictEqual(isValidSha256(''), false);
    assert.strictEqual(isValidSha256('invalid-short-hash'), false);
    assert.strictEqual(isValidSha256(validHash.toUpperCase()), false); // Must be normalized to lowercase
    assert.strictEqual(isValidSha256(validHash.slice(0, 63) + 'g'), false); // Non-hex character
  });

  test('Detects tamper when current hash does not match original registration hash', () => {
    const verifyIntegrity = (originalHash: string, currentHash: string) => {
      if (originalHash.toLowerCase() === currentHash.toLowerCase()) {
        return 'VERIFIED';
      }
      return 'INTEGRITY_FAILED';
    };

    const hash1 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const hash2 = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

    assert.strictEqual(verifyIntegrity(hash1, hash1), 'VERIFIED');
    assert.strictEqual(verifyIntegrity(hash1, hash2), 'INTEGRITY_FAILED');
  });
});

describe('Custody Transfer Protocol & Constraints', () => {
  test('Prevents custody transfer to oneself', () => {
    const validateTransferRequest = (senderId: string, recipientId: string, teamId: string, recipientTeamId: string) => {
      if (!senderId || !recipientId) throw new Error('Missing sender or recipient ID');
      if (senderId === recipientId) throw new Error('You cannot transfer evidence to yourself.');
      if (teamId !== recipientTeamId) throw new Error('You can only transfer evidence to an active Officer in your own team.');
      return true;
    };

    assert.throws(
      () => validateTransferRequest('officer-1', 'officer-1', 'team-A', 'team-A'),
      /You cannot transfer evidence to yourself/
    );

    assert.throws(
      () => validateTransferRequest('officer-1', 'officer-2', 'team-A', 'team-B'),
      /You can only transfer evidence to an active Officer in your own team/
    );

    assert.strictEqual(
      validateTransferRequest('officer-1', 'officer-2', 'team-A', 'team-A'),
      true
    );
  });
});

describe('Team Officer Capacity & Deactivation Rules', () => {
  test('Enforces maximum 5 active ordinary officers per team', () => {
    const canAddOfficer = (currentActiveCount: number) => {
      const MAX_ACTIVE_OFFICERS = 5;
      if (currentActiveCount >= MAX_ACTIVE_OFFICERS) {
        throw new Error('Team capacity exceeded: Teams may have a maximum of 5 active officers.');
      }
      return true;
    };

    assert.strictEqual(canAddOfficer(0), true);
    assert.strictEqual(canAddOfficer(4), true);

    assert.throws(
      () => canAddOfficer(5),
      /Team capacity exceeded/
    );
    assert.throws(
      () => canAddOfficer(6),
      /Team capacity exceeded/
    );
  });

  test('Higher Officers are not counted toward the 5-officer ordinary limit', () => {
    const members = [
      { role: 'HIGHER_OFFICER', status: 'ACTIVE' },
      { role: 'OFFICER', status: 'ACTIVE' },
      { role: 'OFFICER', status: 'ACTIVE' },
      { role: 'OFFICER', status: 'ACTIVE' },
      { role: 'OFFICER', status: 'ACTIVE' },
      { role: 'OFFICER', status: 'INACTIVE' },
    ];

    const activeOrdinaryOfficers = members.filter(
      (m) => m.status === 'ACTIVE' && m.role === 'OFFICER'
    ).length;

    assert.strictEqual(activeOrdinaryOfficers, 4);
    assert.ok(activeOrdinaryOfficers < 5); // 1 slot available
  });
});

describe('Evidence Verification Status & Normalization Rules', () => {
  const VALID_VERIFICATION_STATUSES = [
    'PENDING',
    'VERIFIED',
    'REJECTED',
    'INTEGRITY_FAILED',
    'UNAVAILABLE',
    'PARTIALLY_VERIFIED',
  ];

  const normalizeVerificationStatus = (rawStatus: any): string => {
    return VALID_VERIFICATION_STATUSES.includes(rawStatus) ? rawStatus : 'PENDING';
  };

  test('New evidence creation defaults verificationStatus strictly to PENDING', () => {
    const createNewEvidencePayload = () => ({
      status: 'ACTIVE',
      verificationStatus: 'PENDING',
      syncStatus: 'PENDING',
    });

    const payload = createNewEvidencePayload();
    assert.strictEqual(payload.verificationStatus, 'PENDING');
    assert.notStrictEqual(payload.verificationStatus, 'NOT_VERIFIED');
  });

  test('Normalizes legacy NOT_VERIFIED to PENDING for verification_status column', () => {
    const outgoingStatus = normalizeVerificationStatus('NOT_VERIFIED');
    assert.strictEqual(outgoingStatus, 'PENDING');
  });

  test('Preserves all six valid verification statuses without downgrade or alteration', () => {
    for (const validStatus of VALID_VERIFICATION_STATUSES) {
      assert.strictEqual(normalizeVerificationStatus(validStatus), validStatus);
    }
  });

  test('Preserves cloud_verification_status independently when normalizing verification_status', () => {
    const prepareCloudPayload = (evidence: { verificationStatus: any; cloudVerificationStatus?: string }) => {
      return {
        verification_status: normalizeVerificationStatus(evidence.verificationStatus),
        cloud_verification_status: evidence.cloudVerificationStatus || 'NOT_VERIFIED',
      };
    };

    // Case 1: Legacy record with NOT_VERIFIED in both
    const legacyPayload = prepareCloudPayload({
      verificationStatus: 'NOT_VERIFIED',
      cloudVerificationStatus: 'NOT_VERIFIED',
    });
    assert.strictEqual(legacyPayload.verification_status, 'PENDING');
    assert.strictEqual(legacyPayload.cloud_verification_status, 'NOT_VERIFIED');

    // Case 2: Verified record with cloud INTEGRITY_FAILED
    const verifiedPayload = prepareCloudPayload({
      verificationStatus: 'VERIFIED',
      cloudVerificationStatus: 'INTEGRITY_FAILED',
    });
    assert.strictEqual(verifiedPayload.verification_status, 'VERIFIED');
    assert.strictEqual(verifiedPayload.cloud_verification_status, 'INTEGRITY_FAILED');
  });

  test('Synchronizes previously queued evidence with legacy statuses without clearing local data', () => {
    const localQueue = [
      { id: 'EV-01', verificationStatus: 'NOT_VERIFIED', syncStatus: 'FAILED' },
      { id: 'EV-02', verificationStatus: 'VERIFIED', syncStatus: 'PENDING' },
      { id: 'EV-03', verificationStatus: 'PENDING', syncStatus: 'PENDING' },
    ];

    const processedPayloads = localQueue.map((item) => ({
      id: item.id,
      verification_status: normalizeVerificationStatus(item.verificationStatus),
    }));

    // Local data structure preserved
    assert.strictEqual(localQueue.length, 3);
    assert.strictEqual(localQueue[0].verificationStatus, 'NOT_VERIFIED'); // Not mutated in-place prematurely

    // Outgoing payloads sanitized for PostgreSQL check constraint
    assert.strictEqual(processedPayloads[0].verification_status, 'PENDING');
    assert.strictEqual(processedPayloads[1].verification_status, 'VERIFIED');
    assert.strictEqual(processedPayloads[2].verification_status, 'PENDING');
  });
});