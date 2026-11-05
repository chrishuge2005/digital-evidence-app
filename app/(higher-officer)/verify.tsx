import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { VerificationStatusBadge } from '../../components/VerificationStatusBadge';
import { higherOfficerService } from '../../services/higherOfficerService';
import { supabase } from '../../services/supabase';
import { Evidence, EvidenceAttachment, VerificationStatus } from '../../types/evidence';
import { safeFormatDate } from '../../utils/dateUtils';
import { Ionicons } from '@expo/vector-icons';

// Memoized Card Component to prevent FlatList frame drops
const VerificationCard = React.memo(({ item, onPress }: { item: { evidence: Evidence; attachments: EvidenceAttachment[] }; onPress: (id: string) => void }) => {
  const evidenceId = item.evidence.evidenceId || (item.evidence as any).evidence_id;
  const capturedDate = safeFormatDate(item.evidence.capturedAt || item.evidence.createdAt);

  return (
    <TouchableOpacity 
      style={styles.card}
      activeOpacity={0.8}
      onPress={() => onPress(evidenceId)}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.evidenceId}>{evidenceId}</Text>
        <VerificationStatusBadge status={(item.evidence.verificationStatus as VerificationStatus) || 'PENDING'} />
      </View>

      <Text style={styles.evidenceTitle}>{item.evidence.title || 'Untitled Evidence'}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Attachments: {item.attachments?.length || 0}</Text>
        <Text style={styles.metaText}>Location: {item.evidence.location || 'N/A'}</Text>
      </View>
      <Text style={styles.dateText}>Captured: {capturedDate}</Text>
    </TouchableOpacity>
  );
});

export default function HigherOfficerVerify() {
  const router = useRouter();
  const [evidenceList, setEvidenceList] = useState<{ evidence: Evidence; attachments: EvidenceAttachment[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);

  // 1. Load data and verify role when the tab is focused
  useFocusEffect(
    useCallback(() => {
      verifyRoleAndLoadData();
    }, [])
  );

  // 2. Realtime Listener for instant UI update when evidence status changes
  useEffect(() => {
    const channel = supabase.channel('public:evidence_verification_updates');

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'evidence' },
      () => {
        loadTeamEvidenceFromCloud();
      }
    );

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const verifyRoleAndLoadData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Part 5: Corrected user_id column query
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle();

        const role = profile?.role ? String(profile.role).toUpperCase() : '';
        const isAuthorized = role === 'HIGHER_OFFICER' || role === 'ADMIN';
        setHasAccess(isAuthorized);
      }

      await loadTeamEvidenceFromCloud();
    } catch (error) {
      console.error('Role verification error:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadTeamEvidenceFromCloud = async () => {
    try {
      const dashboardData = await higherOfficerService.getTeamDashboardData();
      const teamId = dashboardData?.team?.id;

      if (!teamId) {
        setEvidenceList([]);
        return;
      }

      // Part 8: Replaced N+1 query loop with a single relational query
      const { data: dbEvidence, error: evidenceError } = await supabase
        .from('evidence')
        .select(`
          *,
          evidence_attachments(*)
        `)
        .eq('team_id', teamId)
        .neq('verification_status', 'VERIFIED')
        .order('created_at', { ascending: false });

      if (evidenceError) {
        console.error('Error fetching team evidence from cloud:', evidenceError);
        setEvidenceList([]);
        return;
      }

      const pendingEvidence = (dbEvidence || []).filter(
        (ev: any) => (ev.verification_status || ev.verificationStatus) !== 'VERIFIED'
      );

      const formattedList = pendingEvidence.map((ev: any) => {
        const evidenceId = ev.evidence_id || ev.id;
        const rawAttachments = ev.evidence_attachments || [];

        const mappedEvidence: Evidence = {
          evidenceId: evidenceId,
          teamId: ev.team_id || teamId,
          ownerId: ev.owner_id,
          assignedOfficerId: ev.assigned_officer_id || ev.owner_id,
          title: ev.title || 'Untitled Evidence',
          description: ev.description || '',
          category: ev.category || 'General',
          location: ev.location || 'N/A',
          capturedAt: ev.captured_at || ev.created_at,
          verificationStatus: ev.verification_status || 'PENDING',
          syncStatus: 'SYNCED',
          createdAt: ev.created_at,
          updatedAt: ev.updated_at || ev.created_at,
          status: ev.status || 'ACTIVE',
        };

        const mappedAttachments: EvidenceAttachment[] = rawAttachments.map((att: any) => ({
          id: att.id,
          attachmentId: att.attachment_id || att.id,
          evidenceId: evidenceId,
          originalName: att.original_name || 'file',
          mimeType: att.mime_type || 'application/octet-stream',
          fileSize: att.file_size || 0,
          localUri: att.local_uri || '',
          storageFileId: att.storage_file_id,
          sha256: att.sha256,
          uploadStatus: att.upload_status || 'UPLOADED',
          cloudVerificationStatus: att.cloud_verification_status || 'NOT_VERIFIED',
          cloudLastVerifiedHash: att.cloud_last_verified_hash || null,
          cloudLastVerifiedAt: att.cloud_last_verified_at || null,
          createdAt: att.created_at,
          updatedAt: att.updated_at || att.created_at,
        }));

        return {
          evidence: mappedEvidence,
          attachments: mappedAttachments,
        };
      });

      setEvidenceList(formattedList);
    } catch (error) {
      console.error('Error loading team evidence:', error);
      setEvidenceList([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    verifyRoleAndLoadData();
  };

  const handlePress = useCallback((evidenceId: string) => {
    router.push(`/(higher-officer)/evidence/${evidenceId}`);
  }, [router]);

  const renderItem = useCallback(({ item }: { item: { evidence: Evidence; attachments: EvidenceAttachment[] } }) => (
    <VerificationCard item={item} onPress={handlePress} />
  ), [handlePress]);

  if (!hasAccess) {
    return (
      <ScreenContainer>
        <View style={styles.centerContainer}>
          <Ionicons name="lock-closed-outline" size={48} color="#DC2626" style={{ marginBottom: 12 }} />
          <Text style={styles.restrictedTitle}>Access Restricted</Text>
          <Text style={styles.restrictedSubtext}>Only Higher Officers have permission to access the official verification queue.</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.title}>Pending Verifications</Text>
        <Text style={styles.subtitle}>Review and verify digital evidence integrity against original fingerprints.</Text>

        {loading && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.infoText}>Loading verification queue...</Text>
          </View>
        ) : evidenceList.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="checkmark-done-circle-outline" size={54} color="#16A34A" style={{ marginBottom: 12 }} />
            <Text style={styles.emptyText}>All Caught Up!</Text>
            <Text style={styles.emptySubtext}>There is no unverified evidence waiting in your team queue.</Text>
          </View>
        ) : (
          <FlatList
            data={evidenceList}
            keyExtractor={(item) => item.evidence.evidenceId}
            renderItem={renderItem}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews={true}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContainer}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748B', marginBottom: 16 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  infoText: { fontSize: 14, color: '#64748B', marginTop: 10 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  emptyText: { fontSize: 18, fontWeight: 'bold', color: '#16A34A', textAlign: 'center', marginBottom: 4 },
  emptySubtext: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20 },
  restrictedTitle: { fontSize: 18, fontWeight: 'bold', color: '#DC2626', marginBottom: 6 },
  restrictedSubtext: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20 },
  listContainer: { paddingBottom: 24 },
  card: {
    backgroundColor: '#FFF',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    elevation: 1,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  evidenceId: { fontSize: 13, color: '#007AFF', fontWeight: 'bold', fontFamily: 'monospace' },
  evidenceTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  metaText: { fontSize: 12, color: '#64748B' },
  dateText: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
});