import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, RefreshControl, TextInput, Alert } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';
import { higherOfficerService, TeamOfficerSummary } from '../../services/higherOfficerService';
import { analyticsService } from '../../services/analyticsService';
import { teamService } from '../../services/teamService';
import { TeamAnalytics } from '../../types/search';

export default function HigherOfficerDashboard() {
  const router = useRouter();
  const [team, setTeam] = useState<any>(null);
  const [stats, setStats] = useState<TeamAnalytics | null>(null);
  const [officers, setOfficers] = useState<TeamOfficerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Team creation state (when Higher Officer has no team yet)
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamCode, setNewTeamCode] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      loadDashboardData();
    }, [])
  );

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      
      // Fetch team context and officer preview list
      const { team: teamData, officers: officersData, stats: defaultStats } = await higherOfficerService.getTeamDashboardData();
      setTeam(teamData);
      setOfficers(officersData || []);

      if (teamData?.id) {
        // Fetch optimized team analytics securely via RLS
        try {
          const analyticsData = await analyticsService.getHigherOfficerTeamStatistics(teamData.id);
          setStats(analyticsData);
        } catch (analyticsErr) {
          console.warn('Analytics service fallback:', analyticsErr);
          setStats(defaultStats);
        }
      } else {
        setStats(defaultStats);
      }
      
    } catch (err: any) {
      console.error('Error loading Higher Officer dashboard:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!newTeamName.trim() || !newTeamCode.trim()) {
      Alert.alert('Missing Details', 'Please provide both a department name and team code.');
      return;
    }

    try {
      setCreatingTeam(true);
      const created = await teamService.createTeam(newTeamName.trim(), newTeamCode.trim().toUpperCase());
      if (created) {
        Alert.alert('Success', `Department team "${created.name}" created successfully.`);
        setNewTeamName('');
        setNewTeamCode('');
        await loadDashboardData();
      }
    } catch (err: any) {
      Alert.alert('Creation Failed', err?.message || 'Failed to create department team.');
    } finally {
      setCreatingTeam(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadDashboardData();
  };

  const verifyRate = stats?.totalEvidence ? Math.round((stats.verified / stats.totalEvidence) * 100) : 0;

  if (loading && !team && !refreshing) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading Analytics Dashboard...</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <ScrollView 
        contentContainerStyle={styles.container} 
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* If no team is associated yet, provide initial Department Team Setup Card */}
        {!team ? (
          <View style={styles.setupCard}>
            <View style={styles.setupHeader}>
              <Text style={styles.setupBadge}>SETUP REQUIRED</Text>
              <Text style={styles.setupTitle}>Configure Department Team</Text>
              <Text style={styles.setupDescription}>
                As a Higher Officer, you need an assigned department team to supervise officers, inspect custody chains, and monitor digital evidence integrity.
              </Text>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.inputLabel}>Department / Unit Name</Text>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. Cyber Crime Investigation Unit"
                placeholderTextColor="#94A3B8"
                value={newTeamName}
                onChangeText={setNewTeamName}
                editable={!creatingTeam}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.inputLabel}>Department Code</Text>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. CCIU-01"
                placeholderTextColor="#94A3B8"
                autoCapitalize="characters"
                value={newTeamCode}
                onChangeText={setNewTeamCode}
                editable={!creatingTeam}
              />
            </View>

            <PrimaryButton
              title={creatingTeam ? 'Registering Department...' : 'Create Department Team'}
              onPress={handleCreateTeam}
              disabled={creatingTeam}
              style={{ marginTop: 12, backgroundColor: '#007AFF' }}
            />
          </View>
        ) : (
          <>
            {/* Team Header Panel */}
            <View style={styles.headerCard}>
              <Text style={styles.badgeText}>HIGHER OFFICER CONTROL PANEL</Text>
              <Text style={styles.teamTitle}>{team?.name || 'Department Team'}</Text>
              <Text style={styles.teamCode}>Team Code: {team?.team_code || 'N/A'}</Text>
            </View>

            {/* Quick Navigation Buttons */}
            <View style={styles.quickActionsRow}>
              <PrimaryButton 
                title="Manage Team" 
                onPress={() => router.push('/(higher-officer)/team')} 
                style={{ flex: 1, marginRight: 6, backgroundColor: '#007AFF' }} 
              />
              <PrimaryButton 
                title="Cases" 
                onPress={() => router.push('/(higher-officer)/cases')} 
                style={{ flex: 1, marginLeft: 6, backgroundColor: '#059669' }} 
              />
            </View>

            {/* Dynamic Statistics Grid */}
            <Text style={styles.sectionTitle}>Team Analytics Overview</Text>
            <View style={styles.statsGrid}>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{stats?.totalEvidence || 0}</Text>
                <Text style={styles.statLabel}>Total Evidence</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNumber, { color: '#166534' }]}>{stats?.verified || 0}</Text>
                <Text style={styles.statLabel}>Verified ({verifyRate}%)</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{stats?.pendingVerify || 0}</Text>
                <Text style={styles.statLabel}>Pending Verify</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNumber, { color: '#991B1B' }]}>{stats?.failedVerify || 0}</Text>
                <Text style={styles.statLabel}>Integrity Failed</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{stats?.pendingTransfers || 0}</Text>
                <Text style={styles.statLabel}>Pending Transfers</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{stats?.activeOfficers || 0}</Text>
                <Text style={styles.statLabel}>Active Officers</Text>
              </View>
            </View>

            {/* Active Officers List Preview */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Team Officers ({officers.length})</Text>
              <Pressable onPress={() => router.push('/(higher-officer)/team')}>
                <Text style={styles.seeAllText}>Manage Team</Text>
              </Pressable>
            </View>

            {officers.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No officers registered in this department yet.</Text>
                <Pressable onPress={() => router.push('/(higher-officer)/team')} style={{ marginTop: 8 }}>
                  <Text style={{ color: '#007AFF', fontWeight: '600' }}>+ Add Team Members</Text>
                </Pressable>
              </View>
            ) : (
              officers.slice(0, 3).map(officer => (
                <Pressable 
                  key={officer.userId} 
                  style={styles.officerCard}
                  onPress={() => router.push({
                    pathname: '/(higher-officer)/officer-details',
                    params: { userId: officer.userId }
                  })}
                >
                  <View style={styles.officerInfo}>
                    <Text style={styles.officerName}>{officer.displayName}</Text>
                    <Text style={styles.officerEmail}>{officer.email}</Text>
                  </View>
                  <View style={styles.officerStatsBadge}>
                    <Text style={styles.officerStatText}>{officer.evidenceCount} Evidence</Text>
                    <Text style={[styles.statusIndicator, officer.status === 'ACTIVE' ? styles.activeDot : styles.inactiveDot]} />
                  </View>
                </Pressable>
              ))
            )}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#666' },
  headerCard: { backgroundColor: '#1E293B', padding: 20, borderRadius: 12, marginBottom: 16, elevation: 2 },
  badgeText: { color: '#38BDF8', fontSize: 11, fontWeight: 'bold', marginBottom: 4, letterSpacing: 1 },
  teamTitle: { color: '#FFF', fontSize: 22, fontWeight: 'bold' },
  teamCode: { color: '#94A3B8', fontSize: 13, marginTop: 2 },
  quickActionsRow: { flexDirection: 'row', marginBottom: 20 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 12, marginTop: 8 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 12 },
  seeAllText: { color: '#007AFF', fontWeight: '600', fontSize: 14 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 12 },
  statBox: { backgroundColor: '#FFF', width: '31%', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, alignItems: 'center', elevation: 1 },
  statNumber: { fontSize: 20, fontWeight: 'bold', color: '#007AFF', marginBottom: 2 },
  statLabel: { fontSize: 11, color: '#64748B', textAlign: 'center' },
  emptyCard: { backgroundColor: '#FFF', padding: 20, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center', marginBottom: 12 },
  emptyText: { color: '#888', fontStyle: 'italic' },
  officerCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, elevation: 1 },
  officerInfo: { flex: 1 },
  officerName: { fontSize: 15, fontWeight: 'bold', color: '#1E293B' },
  officerEmail: { fontSize: 13, color: '#64748B', marginTop: 2 },
  officerStatsBadge: { alignItems: 'flex-end' },
  officerStatText: { fontSize: 13, fontWeight: '600', color: '#007AFF', marginBottom: 4 },
  statusIndicator: { width: 8, height: 8, borderRadius: 4 },
  activeDot: { backgroundColor: '#22C55E' },
  inactiveDot: { backgroundColor: '#EF4444' },

  // Setup card styles
  setupCard: { backgroundColor: '#FFF', padding: 24, borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  setupHeader: { marginBottom: 16 },
  setupBadge: { color: '#0284C7', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 6 },
  setupTitle: { fontSize: 22, fontWeight: 'bold', color: '#0F172A', marginBottom: 8 },
  setupDescription: { fontSize: 14, color: '#475569', lineHeight: 20 },
  formGroup: { marginBottom: 14 },
  inputLabel: { fontSize: 13, fontWeight: '600', color: '#334155', marginBottom: 6 },
  textInput: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#1E293B' }
});
