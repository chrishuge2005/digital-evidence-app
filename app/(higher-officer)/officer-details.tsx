import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable, FlatList } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { higherOfficerService, TeamOfficerSummary } from '../../services/higherOfficerService';
import { VerificationStatusBadge } from '../../components/VerificationStatusBadge';

// OPTIMIZATION 9 & 11: Memoized Evidence Card to prevent re-rendering and repeated Date parsing
const EvidenceCard = React.memo(({ item, onPress }: { item: any, onPress: (id: string) => void }) => {
  const id = item.evidence_id || item.evidenceId;
  const status = item.verification_status || item.verificationStatus;
  const dateStr = item.captured_at || item.capturedAt 
    ? new Date(item.captured_at || item.capturedAt).toLocaleString() 
    : 'N/A';

  return (
    <Pressable 
      style={styles.evidenceCard}
      onPress={() => onPress(id)}
    >
      <View style={styles.evidenceCardHeader}>
        <Text style={styles.evidenceIdText}>{id}</Text>
        <VerificationStatusBadge status={status} />
      </View>
      <Text style={styles.evidenceTitleText}>{item.title}</Text>
      <Text style={styles.evidenceMetaText}>Captured: {dateStr}</Text>
    </Pressable>
  );
});

export default function OfficerDetailsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const [officer, setOfficer] = useState<TeamOfficerSummary | null>(null);
  const [assignedEvidence, setAssignedEvidence] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      loadOfficerDetails();
    }, [userId])
  );

  const loadOfficerDetails = async () => {
    if (!userId) return;
    try {
      setLoading(true);
      // 1. Get dashboard stats to find the officer's profile
      const { team, officers } = await higherOfficerService.getTeamDashboardData();
      const found = officers.find(o => o.userId === userId);
      if (found) setOfficer(found);
      if (!team) return;

      // OPTIMIZATION 4 & 18: Fetch only THIS officer's evidence via DB query, omit attachments
      const officerEvidence = await higherOfficerService.getTeamEvidence(team.id, {
        ownerId: userId as string,
        includeAttachments: false
      });
      
      setAssignedEvidence(officerEvidence);
    } catch (err) {
      console.error('Error loading officer details:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleEvidencePress = useCallback((evidenceId: string) => {
    router.push({
      pathname: '/(higher-officer)/evidence/[evidenceId]',
      params: { evidenceId }
    });
  }, [router]);

  // OPTIMIZATION 9: Stable render item function
  const renderItem = useCallback(({ item }: { item: any }) => (
    <EvidenceCard item={item} onPress={handleEvidencePress} />
  ), [handleEvidencePress]);

  // Construct the top half of the screen as a ListHeader to preserve scroll performance
  const renderHeader = () => {
    if (!officer) return null;
    return (
      <>
        <Text style={styles.headerTitle}>{officer.displayName}</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Email Address</Text>
          <Text style={styles.value}>{officer.email}</Text>

          <Text style={styles.label}>System Role</Text>
          <Text style={styles.value}>{officer.role}</Text>

          <Text style={styles.label}>Membership Status</Text>
          <Text style={[styles.badge, officer.status === 'ACTIVE' ? styles.activeBadge : styles.inactiveBadge]}>
            {officer.status}
          </Text>

          <Text style={styles.label}>Joined Team At</Text>
          <Text style={styles.value}>{new Date(officer.joinedAt).toLocaleString()}</Text>
        </View>

        {/* Officer Performance Statistics */}
        <Text style={styles.sectionTitle}>Officer Evidence Metrics</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{officer.evidenceCount}</Text>
            <Text style={styles.statText}>Total Assigned</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#166534' }]}>{officer.verifiedCount}</Text>
            <Text style={styles.statText}>Verified</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#DC2626' }]}>{officer.failedCount}</Text>
            <Text style={styles.statText}>Failed</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Assigned Evidence Records ({assignedEvidence.length})</Text>
      </>
    );
  };

  if (loading) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading officer details...</Text>
        </View>
      </ScreenContainer>
    );
  }

  if (!officer) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <Text style={styles.errorText}>Officer not found or unauthorized.</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      {/* OPTIMIZATION 9: FlatList used instead of ScrollView + .map() */}
      <FlatList
        data={assignedEvidence}
        keyExtractor={(item) => item.id || item.evidence_id || item.evidenceId}
        ListHeaderComponent={renderHeader}
        renderItem={renderItem}
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No evidence currently assigned to this officer.</Text>
          </View>
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#666' },
  errorText: { color: '#DC2626', fontSize: 16, fontWeight: 'bold' },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#1E293B', marginBottom: 16 },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 20, elevation: 1 },
  label: { fontSize: 12, color: '#64748B', marginTop: 10 },
  value: { fontSize: 15, fontWeight: '600', color: '#1E293B', marginTop: 2 },
  badge: { alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, fontSize: 12, fontWeight: 'bold', overflow: 'hidden' },
  activeBadge: { backgroundColor: '#DCFCE7', color: '#166534' },
  inactiveBadge: { backgroundColor: '#FEE2E2', color: '#991B1B' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 12, marginTop: 4 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  statBox: { backgroundColor: '#FFF', flex: 1, marginHorizontal: 4, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center', elevation: 1 },
  statNum: { fontSize: 20, fontWeight: 'bold', color: '#007AFF', marginBottom: 2 },
  statText: { fontSize: 11, color: '#64748B', textAlign: 'center' },
  emptyCard: { backgroundColor: '#FFF', padding: 20, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center', marginBottom: 12 },
  emptyText: { color: '#888', fontStyle: 'italic' },
  evidenceCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, elevation: 1 },
  evidenceCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  evidenceIdText: { fontSize: 13, fontWeight: 'bold', color: '#007AFF', fontFamily: 'monospace' },
  evidenceTitleText: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 6 },
  evidenceMetaText: { fontSize: 12, color: '#64748B' }
});