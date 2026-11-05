import { Alert } from 'react-native';
import { supabase } from '../services/supabase'; // Adjust the import path if needed
import { evidenceService } from '../services/evidenceService'; // Adjust the import path if needed

// Replace your existing verification handler with this complete function
const handleOfficialVerification = async (evidenceId: string, status: 'VERIFIED' | 'REJECTED') => {
  try {
    // 1. Get the currently logged-in user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      Alert.alert('Error', 'You must be logged in to verify evidence.');
      return;
    }

    // 2. Fetch the user's role directly from the profiles table
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      Alert.alert('Error', 'Could not fetch your profile data.');
      return;
    }

    // 3. THE FIX: Check for all possible database string variations of the role
    const validOfficerRoles = ['HIGHER_OFFICER', 'higher_officer', 'ADMIN', 'admin'];
    
    if (!profile || !validOfficerRoles.includes(profile.role)) {
      // This is the exact error you were seeing. It will now be bypassed if your database role matches any string above.
      Alert.alert(
        'Verification Error', 
        'Unauthorized: Only Higher Officers can perform official verification.'
      );
      return;
    }

    // 4. If authorization passes, update the verification status
    const success = await evidenceService.updateVerificationStatus(evidenceId, status);
    
    if (success) {
      Alert.alert('Success', `Evidence successfully marked as ${status}.`);
      // Add any refresh or navigation logic here (e.g., loadEvidenceDetails())
    } else {
      Alert.alert('Error', 'Failed to update evidence status in the cloud.');
    }

  } catch (error: any) {
    Alert.alert('Error', error.message || 'An unexpected error occurred during verification.');
  }
};