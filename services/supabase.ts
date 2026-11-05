import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// SECURITY AUDIT: Phase 19
// Ensure NO service-role keys are present in the environment or client bundle.
// The untrusted client must ONLY use the restricted anon key.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "CRITICAL SECURITY ERROR: Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Please ensure your .env file is configured."
  );
}

// Failsafe: Prevent the application from booting if an admin key was accidentally pasted into the .env file
if (supabaseAnonKey.includes("service_role")) {
  throw new Error(
    "CRITICAL SECURITY ERROR: Service Role Key detected in client bundle. This is a severe vulnerability and has been blocked."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});