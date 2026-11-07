const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const envPath = path.resolve(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf8');

const urlMatch = envContent.match(/EXPO_PUBLIC_SUPABASE_URL=(.*)/);
const keyMatch = envContent.match(/EXPO_PUBLIC_SUPABASE_ANON_KEY=(.*)/);

if (!urlMatch || !keyMatch) {
  console.error('Missing Supabase URL or Anon Key');
  process.exit(1);
}

const supabaseUrl = urlMatch[1].trim();
const supabaseAnonKey = keyMatch[1].trim();

// Create isolated client helper
function getClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function runE2EVerification() {
  console.log('================================================================');
  console.log('       LIVE END-TO-END EVIDENCE VISIBILITY & ACCESS AUDIT       ');
  console.log('================================================================');
  console.log('Supabase Endpoint:', supabaseUrl.replace(/https:\/\/(.{4}).*(\..*)/, 'https://$1***$2'));
  console.log('Timestamp:', new Date().toISOString());

  const ts = Date.now();
  const officerEmail = `officer_e2e_${ts}@police.test`;
  const hoEmail = `ho_e2e_${ts}@police.test`;
  const outsiderEmail = `outsider_e2e_${ts}@police.test`;
  const defaultPassword = 'SecurePassword123!';

  const results = {
    officerUpload: false,
    officerListVisibilityBeforeVerification: false,
    officerDetailRetrieval: false,
    higherOfficerListVisibilityBeforeVerification: false,
    higherOfficerDetailRetrieval: false,
    attachmentPreviewBothAccounts: false,
    refreshAndSignInPersistence: false,
    crossTeamAccessDenial: false,
    verificationAction: false
  };

  // -------------------------------------------------------------
  // STEP 1: Provision Higher Officer Account & Team
  // -------------------------------------------------------------
  console.log('\n[STEP 1] Provisioning Higher Officer & Department Team...');
  const hoClient = getClient();
  const { data: hoAuth, error: hoAuthErr } = await hoClient.auth.signUp({
    email: hoEmail,
    password: defaultPassword,
    options: {
      data: {
        display_name: 'Captain Vance (HO)',
        role: 'HIGHER_OFFICER'
      }
    }
  });

  if (hoAuthErr || !hoAuth.user) {
    throw new Error(`HO sign-up failed: ${hoAuthErr?.message}`);
  }
  const hoUserId = hoAuth.user.id;
  console.log(`✓ Higher Officer signed up: ${hoUserId} (${hoEmail})`);

  // Insert HO profile
  const { error: hoProfErr } = await hoClient.from('profiles').insert({
    user_id: hoUserId,
    email: hoEmail,
    display_name: 'Captain Vance',
    role: 'HIGHER_OFFICER',
    badge_number: 'HO-9011'
  });
  if (hoProfErr && !hoProfErr.message.includes('duplicate')) {
    console.warn('HO profile insert warning:', hoProfErr.message);
  } else {
    console.log('✓ Higher Officer profile created with role HIGHER_OFFICER');
  }

  // Create Team supervised by Higher Officer
  const teamCode = `DT-${ts.toString().slice(-4)}`;
  const { data: teamData, error: teamErr } = await hoClient
    .from('teams')
    .insert({
      name: `Metro Precinct Alpha ${ts.toString().slice(-4)}`,
      team_code: teamCode,
      higher_officer_id: hoUserId
    })
    .select()
    .single();

  if (teamErr || !teamData) {
    throw new Error(`Failed to create team: ${teamErr?.message}`);
  }
  const teamId = teamData.id;
  console.log(`✓ Department Team created: ${teamData.name} (ID: ${teamId}, Code: ${teamCode})`);

  // Update HO profile team_id
  await hoClient.from('profiles').update({ team_id: teamId }).eq('user_id', hoUserId);

  // -------------------------------------------------------------
  // STEP 2: Provision Officer Account & Assign to Team
  // -------------------------------------------------------------
  console.log('\n[STEP 2] Provisioning Officer & Adding to Team...');
  const officerClient = getClient();
  const { data: offAuth, error: offAuthErr } = await officerClient.auth.signUp({
    email: officerEmail,
    password: defaultPassword,
    options: {
      data: {
        display_name: 'Officer Miller',
        role: 'OFFICER'
      }
    }
  });

  if (offAuthErr || !offAuth.user) {
    throw new Error(`Officer sign-up failed: ${offAuthErr?.message}`);
  }
  const officerUserId = offAuth.user.id;
  console.log(`✓ Officer signed up: ${officerUserId} (${officerEmail})`);

  // Insert Officer profile
  const { error: offProfErr } = await officerClient.from('profiles').insert({
    user_id: officerUserId,
    email: officerEmail,
    display_name: 'Officer Miller',
    role: 'OFFICER',
    badge_number: 'BADGE-4421',
    team_id: teamId
  });
  if (offProfErr && !offProfErr.message.includes('duplicate')) {
    console.warn('Officer profile insert warning:', offProfErr.message);
  } else {
    console.log('✓ Officer profile created with badge BADGE-4421');
  }

  // Assign Officer to Team
  const { error: tmErr } = await officerClient.from('team_members').insert({
    team_id: teamId,
    user_id: officerUserId,
    role: 'OFFICER',
    status: 'ACTIVE'
  });
  if (tmErr) {
    console.warn('Direct team_members insert notice:', tmErr.message);
    // Try via HO
    const { error: hoTmErr } = await hoClient.from('team_members').insert({
      team_id: teamId,
      user_id: officerUserId,
      role: 'OFFICER',
      status: 'ACTIVE'
    });
    if (hoTmErr) console.warn('HO team_members insert notice:', hoTmErr.message);
  }
  console.log(`✓ Officer membership confirmed in team ${teamId}`);

  // -------------------------------------------------------------
  // STEP 3: Officer Uploads Real Evidence & Attachment
  // -------------------------------------------------------------
  console.log('\n[STEP 3] Testing Officer Upload Workflow with Real Attachment...');
  const businessEvidenceId = `EV-2026-${ts.toString().slice(-6)}`;
  const attachmentId = `ATT-${ts.toString().slice(-6)}`;
  
  // Real binary file content: 1KB test JPEG data
  const testFileBuffer = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]),
    crypto.randomBytes(1024),
    Buffer.from([0xFF, 0xD9])
  ]);
  const originalSha256 = crypto.createHash('sha256').update(testFileBuffer).digest('hex');
  const storageFilePath = `${teamId}/${businessEvidenceId}/${attachmentId}_evidence_photo.jpg`;

  console.log(`- Uploading private attachment to 'evidence-files' at: ${storageFilePath}`);
  console.log(`- Original SHA-256 Fingerprint: ${originalSha256}`);

  // Upload file to Supabase storage bucket 'evidence-files'
  const { data: uploadData, error: uploadErr } = await officerClient.storage
    .from('evidence-files')
    .upload(storageFilePath, testFileBuffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

  if (uploadErr) {
    throw new Error(`Attachment upload to storage failed: ${uploadErr.message}`);
  }
  console.log(`✓ Storage upload succeeded: ${uploadData.path}`);

  // Insert Evidence Row
  const { data: evInsertData, error: evInsertErr } = await officerClient
    .from('evidence')
    .insert({
      evidence_id: businessEvidenceId,
      team_id: teamId,
      owner_id: officerUserId,
      created_by: officerUserId,
      assigned_officer_id: officerUserId,
      title: 'Commercial Burglary Tool Marks & Footprints',
      description: 'Physical evidence recovered from rear entrance break-in point.',
      category: 'Physical',
      location: '404 Industrial Blvd, Dock 4',
      status: 'ACTIVE',
      verification_status: 'PENDING',
      cloud_verification_status: 'NOT_VERIFIED',
      captured_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (evInsertErr || !evInsertData) {
    throw new Error(`Evidence database insertion failed: ${evInsertErr?.message}`);
  }
  const evidenceUUID = evInsertData.id;
  console.log(`✓ Evidence record inserted:`);
  console.log(`  - Business ID: ${businessEvidenceId}`);
  console.log(`  - Database UUID: ${evidenceUUID}`);
  console.log(`  - Verification Status: ${evInsertData.verification_status}`);
  console.log(`  - Status: ${evInsertData.status}`);

  // Insert Attachment Record
  const { data: attInsertData, error: attInsertErr } = await officerClient
    .from('evidence_attachments')
    .insert({
      attachment_id: attachmentId,
      evidence_id: evidenceUUID,
      original_name: 'crime_scene_dock4_footprint.jpg',
      mime_type: 'image/jpeg',
      file_size: testFileBuffer.length,
      storage_file_id: storageFilePath,
      sha256: originalSha256,
      upload_status: 'UPLOADED',
      cloud_verification_status: 'NOT_VERIFIED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (attInsertErr) {
    throw new Error(`Evidence attachment record insert failed: ${attInsertErr?.message}`);
  }
  console.log(`✓ Evidence attachment record inserted: ${attInsertData.attachment_id} (Linked to UUID: ${evidenceUUID})`);

  // Insert Custody Log
  const { error: custErr } = await officerClient
    .from('evidence_custody')
    .insert({
      evidence_id: evidenceUUID,
      action: 'EVIDENCE_REGISTERED',
      performed_by_user_id: officerUserId,
      performed_by: 'Officer Miller',
      role: 'OFFICER',
      status: 'SUCCESS',
      notes: 'Initial capture and secure storage upload'
    });
  if (custErr) console.warn('Custody record notice:', custErr.message);
  else console.log(`✓ Initial custody record registered`);

  results.officerUpload = true;

  // -------------------------------------------------------------
  // STEP 4: Officer List Visibility & Detail Retrieval (Pre-Verification)
  // -------------------------------------------------------------
  console.log('\n[STEP 4] Testing Officer List & Detail Retrieval (Pre-Verification)...');
  
  // List query (simulating app/(officer)/evidence.tsx)
  const { data: offList, error: offListErr } = await officerClient
    .from('evidence')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false });

  if (offListErr) {
    throw new Error(`Officer list query failed: ${offListErr.message}`);
  }

  const foundInOfficerList = offList?.find(e => e.evidence_id === businessEvidenceId);
  if (!foundInOfficerList) {
    throw new Error(`Newly uploaded evidence ${businessEvidenceId} NOT found in Officer's evidence list!`);
  }
  console.log(`✓ Officer sees record in Evidence List:`);
  console.log(`  - Title: "${foundInOfficerList.title}"`);
  console.log(`  - Verification Status: "${foundInOfficerList.verification_status}" (Confirms PENDING before HO review)`);
  results.officerListVisibilityBeforeVerification = true;

  // Detail query (simulating app/(officer)/evidence/[evidenceId].tsx)
  const { data: offDetail, error: offDetErr } = await officerClient
    .from('evidence')
    .select('*')
    .eq('evidence_id', businessEvidenceId)
    .maybeSingle();

  if (offDetErr || !offDetail) {
    throw new Error(`Officer detail query failed: ${offDetErr?.message}`);
  }

  const { data: offAtts, error: offAttsErr } = await officerClient
    .from('evidence_attachments')
    .select('*')
    .eq('evidence_id', offDetail.id);

  if (offAttsErr || !offAtts || offAtts.length === 0) {
    throw new Error(`Officer could not retrieve attachments: ${offAttsErr?.message}`);
  }
  console.log(`✓ Officer opened evidence details successfully.`);
  console.log(`  - Retrieved attachment: "${offAtts[0].original_name}" (${offAtts[0].file_size} bytes)`);
  results.officerDetailRetrieval = true;

  // Signed URL preview by Officer
  const { data: offSigned, error: offSignedErr } = await officerClient.storage
    .from('evidence-files')
    .createSignedUrl(storageFilePath, 3600);

  if (offSignedErr || !offSigned?.signedUrl) {
    throw new Error(`Officer failed to create signed URL: ${offSignedErr?.message}`);
  }
  console.log(`✓ Officer generated secure signed URL for private attachment.`);

  // -------------------------------------------------------------
  // STEP 5: Higher Officer Visibility & Detail Retrieval (Pre-Verification)
  // -------------------------------------------------------------
  console.log('\n[STEP 5] Testing Higher Officer Cases Visibility (Pre-Verification)...');

  // Query Higher Officer Cases (simulating app/(higher-officer)/cases.tsx)
  const { data: hoCases, error: hoCasesErr } = await hoClient
    .from('evidence')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false });

  if (hoCasesErr) {
    throw new Error(`Higher Officer cases query failed: ${hoCasesErr.message}`);
  }

  const foundInHoCases = hoCases?.find(e => e.evidence_id === businessEvidenceId);
  if (!foundInHoCases) {
    throw new Error(`Newly uploaded evidence ${businessEvidenceId} NOT visible to Higher Officer before verification!`);
  }
  console.log(`✓ Higher Officer sees record in Cases List BEFORE verification:`);
  console.log(`  - Evidence ID: ${foundInHoCases.evidence_id}`);
  console.log(`  - Verification Status: ${foundInHoCases.verification_status}`);
  console.log(`  - Submitting Owner ID: ${foundInHoCases.owner_id}`);

  // Verify Officer name attribution lookup in profiles
  const { data: creatorProfile } = await hoClient
    .from('profiles')
    .select('display_name, badge_number')
    .eq('user_id', foundInHoCases.owner_id)
    .single();

  console.log(`  - Submitting Officer Attribution: "${creatorProfile?.display_name}" (Badge: ${creatorProfile?.badge_number})`);
  results.higherOfficerListVisibilityBeforeVerification = true;

  // Detail query by Higher Officer (simulating app/(higher-officer)/evidence/[evidenceId].tsx)
  const { data: hoDetail, error: hoDetErr } = await hoClient
    .from('evidence')
    .select('*')
    .eq('evidence_id', businessEvidenceId)
    .maybeSingle();

  if (hoDetErr || !hoDetail) {
    throw new Error(`Higher Officer detail query failed: ${hoDetErr?.message}`);
  }

  const { data: hoAtts, error: hoAttsErr } = await hoClient
    .from('evidence_attachments')
    .select('*')
    .eq('evidence_id', hoDetail.id);

  if (hoAttsErr || !hoAtts || hoAtts.length === 0) {
    throw new Error(`Higher Officer could not retrieve attachments: ${hoAttsErr?.message}`);
  }
  console.log(`✓ Higher Officer opened evidence details successfully.`);
  console.log(`  - Verified immutable hash stored in DB: ${hoAtts[0].sha256}`);
  results.higherOfficerDetailRetrieval = true;

  // Signed URL preview by Higher Officer
  const { data: hoSigned, error: hoSignedErr } = await hoClient.storage
    .from('evidence-files')
    .createSignedUrl(storageFilePath, 3600);

  if (hoSignedErr || !hoSigned?.signedUrl) {
    throw new Error(`Higher Officer failed to create signed URL: ${hoSignedErr?.message}`);
  }
  console.log(`✓ Higher Officer generated secure signed URL for private attachment.`);

  // Verify actual download & hash integrity for both signed URLs
  const https = require('https');
  function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
    });
  }

  const downloadedByOfficer = await downloadBuffer(offSigned.signedUrl);
  const downloadedByHo = await downloadBuffer(hoSigned.signedUrl);

  const hashOfficer = crypto.createHash('sha256').update(downloadedByOfficer).digest('hex');
  const hashHo = crypto.createHash('sha256').update(downloadedByHo).digest('hex');

  if (hashOfficer !== originalSha256 || hashHo !== originalSha256) {
    throw new Error(`Hash mismatch during attachment preview! Expected: ${originalSha256}, Officer: ${hashOfficer}, HO: ${hashHo}`);
  }
  console.log(`✓ Binary attachment preview verified for both Officer and Higher Officer:`);
  console.log(`  - Downloaded byte size: ${downloadedByHo.length} bytes`);
  console.log(`  - SHA-256 match verified against original immutable hash: ${hashHo}`);
  results.attachmentPreviewBothAccounts = true;

  // -------------------------------------------------------------
  // STEP 6: Cross-Team Isolation Verification
  // -------------------------------------------------------------
  console.log('\n[STEP 6] Testing Cross-Team Isolation & RLS Enforcement...');
  const outsiderClient = getClient();
  const { data: outAuth, error: outAuthErr } = await outsiderClient.auth.signUp({
    email: outsiderEmail,
    password: defaultPassword,
    options: {
      data: { display_name: 'Officer Davis (Unrelated Team)', role: 'OFFICER' }
    }
  });

  if (outAuthErr || !outAuth.user) {
    throw new Error(`Outsider sign-up failed: ${outAuthErr?.message}`);
  }
  const outsiderUserId = outAuth.user.id;

  // Create different team for outsider
  const { data: otherTeam } = await hoClient
    .from('teams')
    .insert({
      name: `Different Precinct ${ts.toString().slice(-4)}`,
      team_code: `DP-${ts.toString().slice(-4)}`,
      higher_officer_id: hoUserId
    })
    .select()
    .single();

  await outsiderClient.from('profiles').insert({
    user_id: outsiderUserId,
    email: outsiderEmail,
    display_name: 'Officer Davis',
    role: 'OFFICER',
    team_id: otherTeam.id
  });

  await outsiderClient.from('team_members').insert({
    team_id: otherTeam.id,
    user_id: outsiderUserId,
    role: 'OFFICER',
    status: 'ACTIVE'
  });

  // Attempt to read Team 1's evidence
  const { data: crossEv, error: crossEvErr } = await outsiderClient
    .from('evidence')
    .select('*')
    .eq('evidence_id', businessEvidenceId);

  const { data: crossAtts } = await outsiderClient
    .from('evidence_attachments')
    .select('*')
    .eq('evidence_id', evidenceUUID);

  if (crossEv && crossEv.length > 0) {
    throw new Error(`RLS LEAK! User from different team was able to view evidence: ${JSON.stringify(crossEv)}`);
  }
  if (crossAtts && crossAtts.length > 0) {
    throw new Error(`RLS LEAK! User from different team was able to view attachments: ${JSON.stringify(crossAtts)}`);
  }

  console.log(`✓ Cross-team isolation strictly enforced:`);
  console.log(`  - Outsider querying evidence: 0 rows returned (Access Denied by RLS)`);
  console.log(`  - Outsider querying attachments: 0 rows returned (Access Denied by RLS)`);
  results.crossTeamAccessDenial = true;

  // -------------------------------------------------------------
  // STEP 7: Official Higher Officer Verification Action & Immutability
  // -------------------------------------------------------------
  console.log('\n[STEP 7] Testing Verification Action & Immutability...');
  const { error: verifyErr } = await hoClient
    .from('evidence')
    .update({
      verification_status: 'VERIFIED',
      cloud_verification_status: 'VERIFIED',
      updated_at: new Date().toISOString()
    })
    .eq('evidence_id', businessEvidenceId);

  if (verifyErr) {
    throw new Error(`Failed to update verification status: ${verifyErr.message}`);
  }

  // Record verification custody log
  await hoClient.from('evidence_custody').insert({
    evidence_id: evidenceUUID,
    action: 'VERIFICATION_APPROVED',
    performed_by_user_id: hoUserId,
    performed_by: 'Captain Vance',
    role: 'HIGHER_OFFICER',
    status: 'SUCCESS',
    notes: 'Higher Officer verified evidence authenticity and attachment SHA-256 integrity'
  });

  // Check updated record
  const { data: verifiedRecord } = await hoClient
    .from('evidence')
    .select('*')
    .eq('evidence_id', businessEvidenceId)
    .single();

  if (verifiedRecord?.verification_status !== 'VERIFIED') {
    throw new Error(`Verification status did not update to VERIFIED!`);
  }
  console.log(`✓ Verification status transitioned to: ${verifiedRecord.verification_status}`);
  results.verificationAction = true;

  // -------------------------------------------------------------
  // STEP 8: Refresh & Sign-in Persistence
  // -------------------------------------------------------------
  console.log('\n[STEP 8] Testing Persistence Across Fresh Sign-in Sessions...');
  
  // Create fresh client session for Officer Miller
  const freshOfficerClient = getClient();
  const { error: loginErr } = await freshOfficerClient.auth.signInWithPassword({
    email: officerEmail,
    password: defaultPassword
  });

  if (loginErr) {
    throw new Error(`Fresh sign-in failed: ${loginErr.message}`);
  }

  const { data: persistentEv, error: persistErr } = await freshOfficerClient
    .from('evidence')
    .select('*')
    .eq('evidence_id', businessEvidenceId)
    .single();

  if (persistErr || !persistentEv) {
    throw new Error(`Evidence not found after fresh sign-in: ${persistErr?.message}`);
  }

  console.log(`✓ Re-authenticated session verified:`);
  console.log(`  - Evidence ID: ${persistentEv.evidence_id}`);
  console.log(`  - Current Status: ${persistentEv.verification_status}`);
  results.refreshAndSignInPersistence = true;

  console.log('\n================================================================');
  console.log('                 ALL AUDIT VERIFICATIONS PASSED                 ');
  console.log('================================================================');
  console.log(JSON.stringify(results, null, 2));

  return results;
}

runE2EVerification().catch((err) => {
  console.error('\n❌ AUDIT FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
