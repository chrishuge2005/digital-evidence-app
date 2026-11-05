import React, { useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { ScreenContainer } from '../../components/ScreenContainer';
import { useAuth } from '../../contexts/AuthContext';
import { teamService } from '../../services/teamService';
import { invitationService, PendingOfficerInvitation } from '../../services/invitationService';
import { Team } from '../../types/team';
import { Profile } from '../../types/auth';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function OfficerDashboard() {
  const router = useRouter();
  const { profile } = useAuth();
  const [teamInfo, setTeamInfo] = useState<(Team & { higher_officer: Profile }) | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingOfficerInvitation[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    React.useCallback(() => {
      loadDashboardData();
    }, [])
  );

  const loadDashboardData = async () => {
    try {
      const [teamData, invitesData] = await Promise.all([
        teamService.getOfficerTeam(),
        invitationService.getMyPendingInvitations(),
      ]);
      setTeamInfo(teamData);
      setPendingInvites(invitesData || []);
    } catch (err: any) {
      console.error('Error loading dashboard data:', err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <ScreenContainer style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <Text style={styles.title}>Officer Dashboard</Text>
      <Text style={styles.subtitle}>Welcome, {profile?.display_name || 'Officer'}</Text>

      {/* Pending Team Invitations Alert Banner */}
      {pendingInvites.length > 0 && (
        <TouchableOpacity
          style={styles.inviteNoticeBanner}
          activeOpacity={0.8}
          onPress={() => router.push('/(officer)/notifications')}
        >
          <View style={styles.noticeIconBox}>
            <Ionicons name="mail-unread" size={24} color="#007AFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.noticeTitle}>
              {pendingInvites.length === 1
                ? 'Official Team Invitation Waiting'
                : `${pendingInvites.length} Team Invitations Waiting`}
            </Text>
            <Text style={styles.noticeSubtitle}>
              You have been invited to join {pendingInvites[0].team_name}. Tap to view and accept.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#007AFF" />
        </TouchableOpacity>
      )}

      <View style={styles.teamCard}>
        <Text style={styles.cardHeader}>My Team</Text>
        {teamInfo ? (
          <>
            <Text style={styles.label}>Team Name:</Text>
            <Text style={styles.value}>{teamInfo.name}</Text>
            
            <Text style={styles.label}>Higher Officer:</Text>
            <Text style={styles.value}>{teamInfo.higher_officer?.display_name || 'Unknown'}</Text>
          </>
        ) : (
          <View>
            <Text style={styles.emptyText}>You are not currently assigned to a department team.</Text>
            {pendingInvites.length > 0 && (
              <TouchableOpacity
                style={styles.reviewInviteBtn}
                onPress={() => router.push('/(officer)/notifications')}
              >
                <Text style={styles.reviewInviteBtnText}>Review & Accept Pending Invitation</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  subtitle: { fontSize: 15, color: '#64748B', marginBottom: 16, marginTop: 4 },
  inviteNoticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  noticeIconBox: { marginRight: 12 },
  noticeTitle: { fontSize: 15, fontWeight: 'bold', color: '#1E3A8A' },
  noticeSubtitle: { fontSize: 13, color: '#1E40AF', marginTop: 2, lineHeight: 18 },
  teamCard: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
  cardHeader: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#EEE', paddingBottom: 10 },
  label: { fontSize: 12, color: '#64748B', marginTop: 8 },
  value: { fontSize: 18, fontWeight: 'bold', color: '#007AFF' },
  emptyText: { fontSize: 14, color: '#888', fontStyle: 'italic', paddingVertical: 10 },
  reviewInviteBtn: { marginTop: 10, backgroundColor: '#007AFF', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  reviewInviteBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
