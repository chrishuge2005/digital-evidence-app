import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Alert, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../../components/ScreenContainer';
import { custodyService } from '../../../services/custodyService';
import { syncService } from '../../../services/syncService';
import { CustodyEvent } from '../../../types/custody';
import { safeFormatDate } from '../../../utils/dateUtils';

export default function CustodyHistoryScreen() {
  const { evidenceId } = useLocalSearchParams<{ evidenceId: string }>();
  const [events, setEvents] = useState<CustodyEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    React.useCallback(() => {
      loadHistory();
    }, [evidenceId])
  );

  const loadHistory = async () => {
    try {
      if (!evidenceId) return;
      // Use the new merged history to combine local (Pending/Failed) with cloud (Synced)
      const history = await custodyService.getMergedCustodyHistory(evidenceId);
      setEvents(history);
    } catch (error) {
      console.error("Error loading custody history:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRetrySync = async (custodyId: string) => {
    const result = await syncService.syncCustodyEvent(custodyId);
    if (result.success) {
      Alert.alert('Success', 'Custody event successfully synced to the cloud.');
      loadHistory();
    } else {
      Alert.alert('Sync Failed', result.error || 'Check your internet connection and try again.');
      loadHistory(); // Reload to reflect any FAILED status updates
    }
  };

  return (
    <ScreenContainer>
      <Text style={styles.headerTitle}>Chain of Custody</Text>
      <Text style={styles.subtitle}>Immutable Audit Trail for Evidence ID: {evidenceId}</Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading custody history...</Text>
        </View>
      ) : events.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No custody activity recorded yet.</Text>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.custodyId!}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          windowSize={5}
          maxToRenderPerBatch={10}
          initialNumToRender={10}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.actionText}>{item.action.replace(/_/g, ' ')}</Text>
                <View style={[styles.statusBadge, { backgroundColor: item.status === 'SUCCESS' ? '#D1E7DD' : '#F8D7DA' }]}>
                  <Text style={[styles.statusText, { color: item.status === 'SUCCESS' ? '#0F5132' : '#842029' }]}>{item.status}</Text>
                </View>
              </View>

              <Text style={styles.actorText}>Performed By: <Text style={styles.bold}>{item.performedBy}</Text> ({item.role.replace(/_/g, ' ')})</Text>
              <Text style={styles.timeText}>Timestamp: {safeFormatDate(item.timestamp)}</Text>

              {item.notes ? (
                <View style={styles.notesBox}>
                  <Text style={styles.notesLabel}>Notes:</Text>
                  <Text style={styles.notesText}>{item.notes}</Text>
                </View>
              ) : null}

              {/* Phase 11: Cloud Sync Status Footer */}
              <View style={styles.syncFooterRow}>
                <Text style={styles.syncLabel}>Cloud Sync Status:</Text>
                
                {item.syncStatus === 'SYNCED' ? (
                  <View style={[styles.syncBadge, styles.syncSuccess]}>
                    <Text style={styles.syncTextSuccess}>SYNCED</Text>
                  </View>
                ) : item.syncStatus === 'FAILED' ? (
                  <Pressable style={[styles.syncBadge, styles.syncFailed]} onPress={() => handleRetrySync(item.custodyId!)}>
                    <Text style={styles.syncTextFailed}>FAILED (Tap to Retry)</Text>
                  </Pressable>
                ) : (
                  <View style={[styles.syncBadge, styles.syncPending]}>
                    <Text style={styles.syncTextPending}>{item.syncStatus || 'PENDING'}</Text>
                  </View>
                )}
              </View>

              {item.syncError && item.syncStatus === 'FAILED' && (
                <Text style={styles.errorText}>Error: {item.syncError}</Text>
              )}
            </View>
          )}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 40 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 20 },
  loadingText: { marginTop: 10, color: '#666' },
  emptyText: { fontSize: 15, color: '#888', fontStyle: 'italic' },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 10, marginBottom: 12, elevation: 2, borderWidth: 1, borderColor: '#E2E8F0' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  actionText: { fontSize: 15, fontWeight: 'bold', color: '#007AFF' },
  statusBadge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 4 },
  statusText: { fontSize: 10, fontWeight: 'bold' },
  actorText: { fontSize: 13, color: '#4A5568', marginBottom: 4 },
  bold: { fontWeight: '600', color: '#2D3748' },
  timeText: { fontSize: 12, color: '#718096', marginBottom: 8 },
  notesBox: { backgroundColor: '#F7FAFC', padding: 8, borderRadius: 6, marginTop: 4, borderWidth: 1, borderColor: '#EDF2F7', marginBottom: 10 },
  notesLabel: { fontSize: 11, fontWeight: 'bold', color: '#4A5568', marginBottom: 2 },
  notesText: { fontSize: 12, color: '#4A5568', fontStyle: 'italic' },
  
  // New Sync Status Styles
  syncFooterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingTop: 10, marginTop: 4 },
  syncLabel: { fontSize: 11, color: '#64748B', fontWeight: '600' },
  syncBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  syncSuccess: { backgroundColor: '#DCFCE7' },
  syncTextSuccess: { color: '#166534', fontSize: 10, fontWeight: 'bold' },
  syncPending: { backgroundColor: '#FEF9C3' },
  syncTextPending: { color: '#854D0E', fontSize: 10, fontWeight: 'bold' },
  syncFailed: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5' },
  syncTextFailed: { color: '#991B1B', fontSize: 10, fontWeight: 'bold' },
  errorText: { fontSize: 11, color: '#DC2626', marginTop: 8 }
});