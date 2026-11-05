const fs = require('fs');
const path = require('path');
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

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function runAudit() {
  console.log('=== LIVE SUPABASE AUDIT ===');
  console.log('Supabase URL:', supabaseUrl.replace(/https:\/\/(.{4}).*(\..*)/, 'https://$1***$2'));

  // 1. Check connection to evidence table
  try {
    const { data, count, error, status } = await supabase
      .from('evidence')
      .select('id, evidence_id, status, verification_status', { count: 'exact' })
      .limit(5);

    console.log('\n[1] public.evidence check:');
    console.log('HTTP Status:', status);
    if (error) {
      console.log('Error:', error.message, 'Code:', error.code);
    } else {
      console.log('Success! Total accessible rows:', count);
      console.log('Sample rows:', data);
    }
  } catch (e) {
    console.log('[1] Exception querying evidence:', e.message);
  }

  // 2. Check public.evidence_attachments table
  try {
    const { data, count, error, status } = await supabase
      .from('evidence_attachments')
      .select('id, attachment_id, evidence_id, sha256', { count: 'exact' })
      .limit(5);

    console.log('\n[2] public.evidence_attachments check:');
    console.log('HTTP Status:', status);
    if (error) {
      console.log('Error:', error.message, 'Code:', error.code);
    } else {
      console.log('Success! Total accessible rows:', count);
      console.log('Sample rows:', data);
    }
  } catch (e) {
    console.log('[2] Exception querying attachments:', e.message);
  }

  // 3. Check public.teams table
  try {
    const { data, count, error, status } = await supabase
      .from('teams')
      .select('id, name, team_code, higher_officer_id', { count: 'exact' })
      .limit(5);

    console.log('\n[3] public.teams check:');
    console.log('HTTP Status:', status);
    if (error) {
      console.log('Error:', error.message, 'Code:', error.code);
    } else {
      console.log('Success! Teams found:', count);
      console.log('Sample teams:', data);
    }
  } catch (e) {
    console.log('[3] Exception querying teams:', e.message);
  }

  // 4. Check public.team_members table
  try {
    const { data, count, error, status } = await supabase
      .from('team_members')
      .select('id, team_id, user_id, role, status', { count: 'exact' })
      .limit(5);

    console.log('\n[4] public.team_members check:');
    console.log('HTTP Status:', status);
    if (error) {
      console.log('Error:', error.message, 'Code:', error.code);
    } else {
      console.log('Success! Team members found:', count);
      console.log('Sample members:', data);
    }
  } catch (e) {
    console.log('[4] Exception querying team_members:', e.message);
  }

  // 5. Check storage buckets
  try {
    const { data: buckets, error: bError } = await supabase.storage.listBuckets();
    console.log('\n[5] Storage buckets check:');
    if (bError) {
      console.log('Storage bucket error:', bError.message);
    } else {
      console.log('Buckets found:', buckets.map(b => ({ name: b.name, public: b.public, id: b.id })));
    }
  } catch (e) {
    console.log('[5] Exception querying storage buckets:', e.message);
  }

  // 6. Check RPC functions
  try {
    const { data, error } = await supabase.rpc('get_user_team_ids');
    console.log('\n[6] RPC get_user_team_ids check (anon):');
    if (error) {
      console.log('RPC result:', error.message, 'Code:', error.code);
    } else {
      console.log('RPC success! Returned team IDs:', data);
    }
  } catch (e) {
    console.log('[6] Exception calling RPC:', e.message);
  }
}

runAudit().then(() => console.log('\n=== AUDIT COMPLETE ===')).catch(err => console.error('Fatal audit error:', err));
