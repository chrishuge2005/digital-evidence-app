import React from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';
import { useAuth } from '../../contexts/AuthContext';

export default function HOProfileScreen() {
  const router = useRouter();
  const { user, profile, signOut } = useAuth();

  const handleLogout = async () => {
    try {
      await signOut();
      router.replace('/(auth)/login');
    } catch (error: any) {
      Alert.alert('Logout Error', error.message || 'Failed to sign out.');
    }
  };

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.title}>Higher Officer Profile</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Display Name:</Text>
          <Text style={styles.value}>{profile?.display_name || user?.user_metadata?.display_name || 'N/A'}</Text>

          <Text style={styles.label}>Email Address:</Text>
          <Text style={styles.value}>{user?.email || 'N/A'}</Text>

          <Text style={styles.label}>System Role:</Text>
          <Text style={styles.value}>{profile?.role || 'HIGHER_OFFICER'}</Text>
        </View>

        <PrimaryButton 
          title="Sign Out" 
          onPress={handleLogout} 
          style={{ backgroundColor: '#DC2626', marginTop: 20 }} 
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, flex: 1 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 20 },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 20, elevation: 2 },
  label: { fontSize: 12, color: '#666', marginTop: 12 },
  value: { fontSize: 16, fontWeight: '600', color: '#333', marginTop: 4 }
});