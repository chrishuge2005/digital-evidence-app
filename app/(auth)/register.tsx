import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';
import { supabase } from '../../services/supabase';

export default function RegisterScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!email || !password || !displayName) {
      Alert.alert('Missing Fields', 'Please fill out all fields to register.');
      return;
    }

    setLoading(true);
    try {
      // 1. Sign up user with Supabase Auth (metadata passed for trigger)
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            display_name: displayName.trim(),
          },
        },
      });

      if (signUpError) {
        throw signUpError;
      }

      Alert.alert(
        'Registration Successful',
        'Your account has been created successfully. You can now sign in.',
        [{ text: 'OK', onPress: () => router.replace('/(auth)/login') }]
      );
    } catch (error: any) {
      console.error('Registration error:', error);
      Alert.alert('Registration Failed', error.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Officer Registration</Text>
        <Text style={styles.subtitle}>Create your secure digital evidence account</Text>

        <Text style={styles.label}>Display Name</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            placeholder="e.g. Officer John Doe"
            placeholderTextColor="#888"
            value={displayName}
            onChangeText={setDisplayName}
            editable={!loading}
          />
        </View>

        <Text style={styles.label}>Email Address</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            placeholder="e.g. officer@department.gov"
            placeholderTextColor="#888"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            editable={!loading}
          />
        </View>

        <Text style={styles.label}>Password</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            placeholder="At least 6 characters"
            placeholderTextColor="#888"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            editable={!loading}
          />
        </View>

        <PrimaryButton
          title={loading ? 'Creating Account...' : 'Register'}
          onPress={handleRegister}
          disabled={loading}
          style={{ marginTop: 20 }}
        />

        <Text style={styles.switchText} onPress={() => router.push('/(auth)/login')}>
          Already have an account? <Text style={styles.linkText}>Sign In</Text>
        </Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, justifyContent: 'center', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 24 },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 12 },
  inputWrapper: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center', marginBottom: 16 },
  textInput: { fontSize: 16, color: '#333', paddingVertical: 12 },
  switchText: { textAlign: 'center', marginTop: 20, color: '#666', fontSize: 14 },
  linkText: { color: '#007AFF', fontWeight: 'bold' }
});