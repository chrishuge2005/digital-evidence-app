import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScreenContainer } from '../components/ScreenContainer';
import { PrimaryButton } from '../components/PrimaryButton';
import { invitationService, InvitationDetails } from '../services/invitationService';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../services/supabase';

export default function AcceptInviteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string; email?: string }>();
  const rawToken = params.token ? String(params.token).trim() : '';

  const { isAuthenticated, user, refreshProfile } = useAuth();
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    loadInvitation();
  }, [rawToken]);

  const loadInvitation = async () => {
    if (!rawToken) {
      setErrorMsg('No invitation token found in this link. Please check your invitation email.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await invitationService.getInvitationDetails(rawToken);
      if (!data.valid) {
        setErrorMsg(data.reason || 'This invitation is invalid or no longer active.');
      } else {
        setDetails(data);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to inspect invitation.');
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!rawToken) return;

    if (!isAuthenticated || !user) {
      Alert.alert(
        'Authentication Required',
        'Please sign in or register with your invited email address to accept this invitation.',
        [
          {
            text: 'Sign In',
            onPress: () =>
              router.push({
                pathname: '/(auth)/login',
              }),
          },
          {
            text: 'Create Account',
            onPress: () =>
              router.push({
                pathname: '/(auth)/register',
              }),
          },
        ]
      );
      return;
    }

    // Verify email match on client before submitting
    const userEmail = (user.email || '').toLowerCase().trim();
    const invitedEmail = (details?.email || '').toLowerCase().trim();

    if (invitedEmail && userEmail !== invitedEmail) {
      Alert.alert(
        'Account Mismatch',
        `This invitation was issued for "${invitedEmail}", but you are currently signed in as "${userEmail}".\n\nPlease switch accounts to accept.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Switch Account',
            onPress: async () => {
              await supabase.auth.signOut();
              router.replace('/(auth)/login');
            },
          },
        ]
      );
      return;
    }

    setAccepting(true);
    try {
      const result = await invitationService.acceptInvitation(rawToken);
      await refreshProfile();

      Alert.alert(
        'Invitation Accepted',
        result.message || 'You are now an active member of the department team.',
        [
          {
            text: 'Go to Dashboard',
            onPress: () => router.replace('/(officer)/dashboard'),
          },
        ]
      );
    } catch (err: any) {
      Alert.alert('Acceptance Failed', err.message || 'Could not accept invitation.');
    } finally {
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Verifying official invitation...</Text>
        </View>
      </ScreenContainer>
    );
  }

  if (errorMsg || !details) {
    return (
      <ScreenContainer>
        <View style={styles.container}>
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.errorTitle}>Invitation Unavailable</Text>
            <Text style={styles.errorBody}>{errorMsg || 'Unable to load invitation details.'}</Text>
            <PrimaryButton
              title="Return to Login"
              onPress={() => router.replace('/(auth)/login')}
              style={{ marginTop: 20, backgroundColor: '#007AFF' }}
            />
          </View>
        </View>
      </ScreenContainer>
    );
  }

  const currentUserEmail = user?.email?.toLowerCase().trim();
  const isMatchingUser = isAuthenticated && currentUserEmail === details.email?.toLowerCase().trim();

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.badgeText}>OFFICIAL DEPARTMENT INVITATION</Text>
          <Text style={styles.title}>Team Membership Offer</Text>
          <Text style={styles.subtitle}>
            You have been invited to join the authorized chain of custody evidence team.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Department</Text>
            <Text style={styles.infoValue}>{details.teamName}</Text>
          </View>

          {details.teamCode ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Team Code</Text>
              <Text style={styles.codeText}>{details.teamCode}</Text>
            </View>
          ) : null}

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Invited Officer</Text>
            <Text style={styles.infoValue}>{details.displayName}</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Official Email</Text>
            <Text style={styles.infoValue}>{details.email}</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Invited By</Text>
            <Text style={styles.infoValue}>{details.invitedByName}</Text>
          </View>

          {details.expiresAt ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Expires</Text>
              <Text style={styles.infoValueSecondary}>
                {new Date(details.expiresAt).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Identity & Action Section */}
        <View style={[styles.card, { marginTop: 16 }]}>
          {!isAuthenticated ? (
            <View>
              <Text style={styles.authNoticeTitle}>Sign In Required</Text>
              <Text style={styles.authNoticeText}>
                To link your officer profile to this team, please sign in or register with{' '}
                <Text style={{ fontWeight: 'bold', color: '#0F172A' }}>{details.email}</Text>.
              </Text>

              <PrimaryButton
                title="Sign In with Invited Email"
                onPress={() => router.push('/(auth)/login')}
                style={{ marginTop: 14, backgroundColor: '#007AFF' }}
              />

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => router.push('/(auth)/register')}
              >
                <Text style={styles.secondaryButtonText}>Create New Officer Account</Text>
              </TouchableOpacity>
            </View>
          ) : isMatchingUser ? (
            <View>
              <View style={styles.verifiedBox}>
                <Text style={styles.verifiedText}>
                  Authenticated as: <Text style={{ fontWeight: 'bold' }}>{currentUserEmail}</Text>
                </Text>
              </View>

              <PrimaryButton
                title={accepting ? 'Joining Team...' : 'Accept Invitation & Join Team'}
                onPress={handleAccept}
                disabled={accepting}
                style={{ marginTop: 14, backgroundColor: '#16A34A' }}
              />
            </View>
          ) : (
            <View>
              <View style={styles.mismatchBox}>
                <Text style={styles.mismatchTitle}>Signed in with Different Account</Text>
                <Text style={styles.mismatchText}>
                  You are signed in as <Text style={{ fontWeight: 'bold' }}>{currentUserEmail}</Text>,
                  but this invitation is for{' '}
                  <Text style={{ fontWeight: 'bold' }}>{details.email}</Text>.
                </Text>
              </View>

              <PrimaryButton
                title="Switch to Invited Account"
                onPress={async () => {
                  await supabase.auth.signOut();
                  router.replace('/(auth)/login');
                }}
                style={{ marginTop: 14, backgroundColor: '#DC2626' }}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, flexGrow: 1, justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, color: '#64748B', fontSize: 14 },
  header: { marginBottom: 16 },
  badgeText: { color: '#0284C7', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 4 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#0F172A' },
  subtitle: { fontSize: 14, color: '#64748B', marginTop: 4, lineHeight: 20 },
  card: {
    backgroundColor: '#FFFFFF',
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 2,
  },
  errorCard: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
  errorTitle: { fontSize: 18, fontWeight: 'bold', color: '#991B1B', marginBottom: 8 },
  errorBody: { fontSize: 14, color: '#7F1D1D', lineHeight: 20 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  infoLabel: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  infoValue: { fontSize: 14, fontWeight: '600', color: '#0F172A' },
  infoValueSecondary: { fontSize: 13, color: '#475569' },
  codeText: {
    fontFamily: 'monospace',
    fontWeight: 'bold',
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    color: '#0F172A',
  },
  authNoticeTitle: { fontSize: 16, fontWeight: 'bold', color: '#0F172A', marginBottom: 6 },
  authNoticeText: { fontSize: 13, color: '#475569', lineHeight: 18 },
  secondaryButton: {
    marginTop: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  secondaryButtonText: { color: '#334155', fontWeight: '600', fontSize: 14 },
  verifiedBox: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    padding: 12,
    borderRadius: 8,
  },
  verifiedText: { color: '#166534', fontSize: 13 },
  mismatchBox: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    padding: 12,
    borderRadius: 8,
  },
  mismatchTitle: { color: '#991B1B', fontWeight: 'bold', fontSize: 14, marginBottom: 4 },
  mismatchText: { color: '#7F1D1D', fontSize: 13, lineHeight: 18 },
});
