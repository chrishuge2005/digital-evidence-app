import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { ScreenContainer } from '../../components/ScreenContainer';
import { useAuth } from '../../contexts/AuthContext';
import { auditService } from '../../services/auditService';
import { higherOfficerService } from '../../services/higherOfficerService';
import { AuditLog } from '../../types/audit';
import { safeFormatDate } from '../../utils/dateUtils';
import { Ionicons } from '@expo/vector-icons';

export default function TeamAuditScreen() {
  const { team } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadAuditHistory();
  }, [team?.teamId]);

  const loadAuditHistory = async () => {
    try {
      let currentTeamId = team?.teamId;

      // Fallback: If not in context yet, fetch Higher Officer team directly
      if (!currentTeamId) {
        const dashboardData = await higherOfficerService.getTeamDashboardData();
        currentTeamId = dashboardData?.team?.id;
      }

      if (currentTeamId) {
        const data = await auditService.getTeamAuditLogs(currentTeamId, 50);
        setLogs(data || []);
      }
    } catch (err) {
      console.error('Audit fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAuditHistory();
  }, [team?.teamId]);

  const renderItem = ({ item }: { item: AuditLog }) => (
    <View style={styles.auditCard}>
      <View style={styles.auditHeader}>
        <Text style={styles.actionText}>{item.action.replace(/_/g, ' ')}</Text>
        <Text style={[styles.statusBadge, item.status === 'FAILED' || item.status === 'DENIED' ? styles.statusFailed : styles.statusSuccess]}>
          {item.status}
        </Text>
      </View>
      
      <Text style={styles.auditDesc}>{item.description || 'No description provided.'}</Text>
      
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>By: {item.actor_name} ({item.actor_role})</Text>
        <Text style={styles.metaText}>{safeFormatDate(item.created_at)}</Text>
      </View>
      
      {item.evidence_id && (
        <Text style={styles.evidenceRef}>Evidence ID: {item.evidence_id}</Text>
      )}
    </View>
  );

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.pageTitle}>System Audit History</Text>
        <Text style={styles.subtitle}>Immutable Team Activity Ledger</Text>
        
        {loading && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading audit ledger...</Text>
          </View>
        ) : logs.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color="#94A3B8" style={{ marginBottom: 12 }} />
            <Text style={styles.emptyTitle}>No Audit Activity</Text>
            <Text style={styles.emptySubtext}>No immutable custody or system actions have been logged yet.</Text>
          </View>
        ) : (
          <FlatList
            data={logs}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
            windowSize={5}
            maxToRenderPerBatch={10}
            initialNumToRender={10}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  pageTitle: { fontSize: 24, fontWeight: 'bold', color: '#1E293B', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748B', marginBottom: 16 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748B', fontSize: 14 },
  listContainer: { paddingBottom: 32 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 6 },
  emptySubtext: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20 },
  auditCard: {
    backgroundColor: '#FFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  auditHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  actionText: { fontSize: 13, fontWeight: 'bold', color: '#0F172A' },
  statusBadge: { fontSize: 10, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  statusSuccess: { backgroundColor: '#DCFCE7', color: '#166534' },
  statusFailed: { backgroundColor: '#FEE2E2', color: '#991B1B' },
  auditDesc: { fontSize: 13, color: '#334155', marginBottom: 10, lineHeight: 18 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  metaText: { fontSize: 11, color: '#64748B' },
  evidenceRef: { fontSize: 11, fontFamily: 'monospace', color: '#007AFF', marginTop: 4 },
});