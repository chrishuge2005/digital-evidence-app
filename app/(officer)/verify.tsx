import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { VerificationStatusBadge } from '../../components/VerificationStatusBadge';
import { supabase } from '../../services/supabase';
import { Evidence, VerificationStatus } from '../../types/evidence';
import { safeFormatDate } from '../../utils/dateUtils';

// Memoized Card Component 
const PendingCard = React.memo(({ item, onPress }: { item: Evidence, onPress: (id: string) => void }) => {
  return (
    <TouchableOpacity 
      style={styles.card}
      activeOpacity={0.8}
      onPress={() => onPress(item.evidenceId)}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.evidenceId}>{item.evidenceId}</Text>
        <VerificationStatusBadge status={(item.verificationStatus as VerificationStatus) || 'PENDING'} />
      </View>

      <Text style={styles.evidenceTitle}>{item.title || 'Untitled Evidence'}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>{item.category || 'N/A'}</Text>
        <Text style={styles.metaText}>{safeFormatDate(item.createdAt, false)}</Text>
      </View>
    </TouchableOpacity>
  );
});

export default function OfficerVerify() {
  const router = useRouter();
  const [evidenceList, setEvidenceList] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Load data when the tab is focused
  useFocusEffect(
    useCallback(() => {
      loadPendingEvidence();
    }, [])
  );

  // 2. Realtime Listener: Updates instantly if a Higher Officer verifies it while you watch!
  useEffect(() => {
    const channel = supabase.channel('public:evidence_officer_pending');

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'evidence' },
      (payload) => {
        console.log('Realtime change detected on officer pending screen:', payload);
        loadPendingEvidence();
      }
    );

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const loadPendingEvidence = async () => {
    try {
      // 1. Get the current logged-in officer
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setEvidenceList([]);
        return;
      }

      // 2. Fetch ONLY UNVERIFIED evidence owned by this officer
      const { data: dbEvidence, error } = await supabase
        .from('evidence')
        .select('*')
        .eq('owner_id', user.id) // Grabs only this officer's files
        .neq('verification_status', 'VERIFIED') // Hides the verified ones
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching pending evidence:', error);
        setEvidenceList([]);
        return;
      }

      // Extra safeguard filter
      const pendingEvidence = (dbEvidence || []).filter(
        ev => (ev.verification_status || ev.verificationStatus) !== 'VERIFIED'
      );

      // 3. Format the data to match your app's Evidence type
      const mappedEvidence: Evidence[] = pendingEvidence.map(ev => ({
        evidenceId: ev.evidence_id || ev.id,
        teamId: ev.team_id || ev.teamId || '',
        ownerId: ev.owner_id || ev.ownerId || '',
        assignedOfficerId: ev.assigned_officer_id || ev.assignedOfficerId,
        title: ev.title,
        description: ev.description || '',
        category: ev.category || 'General',
        location: ev.location || 'N/A',
        capturedAt: ev.captured_at || ev.capturedAt || ev.created_at,
        originalSha256: ev.original_sha256 || ev.originalSha256,
        verificationStatus: ev.verification_status || ev.verificationStatus || 'PENDING',
        syncStatus: 'SYNCED',
        createdAt: ev.created_at || ev.createdAt,
        updatedAt: ev.updated_at || ev.updatedAt || ev.created_at,
        status: ev.status || 'ACTIVE'
      }));

      setEvidenceList(mappedEvidence);
    } catch (error) {
      console.error('Error in loadPendingEvidence:', error);
      setEvidenceList([]);
    } finally {
      // Only turn loading OFF so it doesn't flash on tab switch
      setLoading(false); 
    }
  };

  const handlePress = useCallback((evidenceId: string) => {
    router.push(`/(officer)/evidence/${evidenceId}`);
  }, [router]);

  return (
    <ScreenContainer>
      <Text style={styles.title}>Pending Verifications</Text>
      <Text style={styles.subtitle}>These files are waiting for a Higher Officer to review and verify.</Text>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.infoText}>Loading pending files...</Text>
        </View>
      ) : evidenceList.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>All Caught Up!</Text>
          <Text style={styles.emptySubtext}>All of your submitted evidence has been verified by a Higher Officer.</Text>
        </View>
      ) : (
        <FlatList
          data={evidenceList}
          keyExtractor={(item) => item.evidenceId}
          renderItem={({ item }) => (
            <PendingCard item={item} onPress={handlePress} />
          )}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
          contentContainerStyle={styles.listContainer}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 20 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  infoText: { fontSize: 15, color: '#666', marginTop: 10 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  emptyText: { fontSize: 18, fontWeight: 'bold', color: '#16A34A', textAlign: 'center' },
  emptySubtext: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 6, lineHeight: 20 },
  listContainer: { paddingBottom: 20 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 15, elevation: 2, borderWidth: 1, borderColor: '#E2E8F0' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  evidenceId: { fontSize: 12, color: '#007AFF', fontWeight: 'bold' },
  evidenceTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: { fontSize: 13, color: '#555' }
});