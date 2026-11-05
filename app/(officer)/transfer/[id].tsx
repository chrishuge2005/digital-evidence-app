import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Alert, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScreenContainer } from '../../../components/ScreenContainer';
import { PrimaryButton } from '../../../components/PrimaryButton';
import { transferService } from '../../../services/transferService';
import { teamService } from '../../../services/teamService';

export default function TransferScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [teamInfo, setTeamInfo] = useState<any>(null);

  useEffect(() => {
    teamService.getOfficerTeam().then(setTeamInfo);
  }, []);

  const handleTransfer = async () => {
    // Strict safety check for missing evidence ID
    if (!id || id === 'undefined' || id === 'null') {
      Alert.alert('Error', 'Evidence ID is missing from navigation.');
      return;
    }
    
    if (!email || !teamInfo?.id) {
      Alert.alert('Missing Info', 'Please enter a valid officer email.');
      return;
    }

    setLoading(true);
    try {
      // 1. Verify recipient belongs to the same active team
      const recipient = await transferService.findRecipientByEmail(teamInfo.id, email);
      
      Alert.alert('Confirm Transfer', `Transfer custody of ${id} to ${recipient.display_name || email}?`, [
        { 
          text: 'Cancel', 
          style: 'cancel', 
          onPress: () => setLoading(false) 
        },
        { 
          text: 'Send Request', 
          onPress: async () => {
            try {
              // 2. Create transfer request and dispatch notification
              await transferService.createTransferRequest(String(id), teamInfo.id, recipient.user_id);
              
              Alert.alert('Transfer Requested', 'Waiting for the recipient officer to accept.', [
                { text: 'OK', onPress: () => router.back() }
              ]);
            } catch (innerErr: any) {
              Alert.alert('Transfer Failed', innerErr.message || 'Failed to request transfer.');
            } finally {
              setLoading(false);
            }
          } 
        }
      ]);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not find officer.');
      setLoading(false);
    }
  };

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.headerTitle}>Transfer Evidence</Text>
        <Text style={styles.evidenceIdText}>ID: {id || 'Unknown ID'}</Text>
        
        <Text style={styles.label}>Receiver's Email</Text>
        <TextInput
          style={styles.input}
          placeholder="officer2@example.com"
          placeholderTextColor="#888"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          editable={!loading}
        />
        
        <PrimaryButton 
          title={loading ? "Processing..." : "Transfer Evidence"} 
          onPress={handleTransfer} 
          disabled={loading || !email} 
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, flex: 1 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', marginBottom: 4, color: '#1E293B' },
  evidenceIdText: { fontSize: 14, fontFamily: 'monospace', color: '#64748B', marginBottom: 24 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#334155' },
  input: { 
    backgroundColor: '#fff', 
    padding: 14, 
    borderRadius: 8, 
    borderWidth: 1, 
    borderColor: '#CBD5E1', 
    marginBottom: 20, 
    fontSize: 16,
    color: '#333'
  }
});