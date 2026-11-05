import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { supabase } from '../../services/supabase';
import { safeFormatDate } from '../../utils/dateUtils';
import { Ionicons } from '@expo/vector-icons';

export default function HONotifications() {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadTeamTransferActivity();
    }, [])
  );

  const loadTeamTransferActivity = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // 1. Find the team owned by this Higher Officer
      const { data: team } = await supabase
        .from('teams')
        .select('id')
        .eq('higher_officer_id', user.id)
        .maybeSingle();

      if (team) {
        // 2. Fetch all transfer requests for this team
        const { data: transferData, error } = await supabase
          .from('transfer_requests')
          .select('*')
          .eq('team_id', team.id)
          .order('created_at', { ascending: false });

        if (error) throw error;

        if (transferData && transferData.length > 0) {
          // 3. Fetch user profiles to display names/emails instead of raw UUIDs
          const userIds = Array.from(new Set(transferData.flatMap(t => [t.from_user_id, t.to_user_id])));
          const { data: profiles } = await supabase
            .from('profiles')
            .select('user_id, email, display_name')
            .in('user_id', userIds);

          const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

          // 4. Combine transfer data with profile information
          const enrichedTransfers = transferData.map(t => ({
            ...t,
            fromUser: profileMap.get(t.from_user_id),
            toUser: profileMap.get(t.to_user_id)
          }));

          setTransfers(enrichedTransfers);
        } else {
          setTransfers([]);
        }
      }
    } catch (error) {
      console.error('Error loading team transfers:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadTeamTransferActivity();
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING': return { bg: '#FEF3C7', text: '#92400E' };
      case 'ACCEPTED': return { bg: '#DCFCE7', text: '#166534' };
      case 'REJECTED': return { bg: '#FEE2E2', text: '#991B1B' };
      default: return { bg: '#F1F5F9', text: '#475569' };
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    const statusStyle = getStatusColor(item.status);

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.evidenceId}>{item.evidence_id}</Text>
          <View style={[styles.badge, { backgroundColor: statusStyle.bg }]}>
            <Text style={[styles.badgeText, { color: statusStyle.text }]}>{item.status}</Text>
          </View>
        </View>

        <View style={styles.transferDetails}>
          <View style={styles.userBox}>
            <Text style={styles.userLabel}>From:</Text>
            <Text style={styles.userName}>{item.fromUser?.display_name || item.fromUser?.email || 'Unknown'}</Text>
          </View>
          <Ionicons name="arrow-forward" size={16} color="#94A3B8" style={{ marginHorizontal: 8 }} />
          <View style={styles.userBox}>
            <Text style={styles.userLabel}>To:</Text>
            <Text style={styles.userName}>{item.toUser?.display_name || item.toUser?.email || 'Unknown'}</Text>
          </View>
        </View>

        <View style={styles.dateContainer}>
          <Text style={styles.dateText}>Requested: {safeFormatDate(item.created_at)}</Text>
          {item.responded_at && (
            <Text style={styles.dateText}>Responded: {safeFormatDate(item.responded_at)}</Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.title}>Team Transfer Activity</Text>
        <Text style={styles.subtitle}>Monitor evidence custody transfers between team officers.</Text>

        {loading && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading transfer ledger...</Text>
          </View>
        ) : transfers.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="swap-horizontal-outline" size={48} color="#94A3B8" style={{ marginBottom: 12 }} />
            <Text style={styles.emptyTitle}>No Transfer Activity</Text>
            <Text style={styles.emptySubtext}>No evidence custody transfers have been requested in your team yet.</Text>
          </View>
        ) : (
          <FlatList
            data={transfers}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
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
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748B', marginBottom: 16 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748B', fontSize: 14 },
  listContent: { paddingBottom: 24 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, marginTop: 40 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  emptySubtext: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  card: { 
    backgroundColor: '#fff', 
    padding: 16, 
    borderRadius: 12, 
    borderWidth: 1, 
    borderColor: '#E2E8F0', 
    marginBottom: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  evidenceId: { fontSize: 13, fontWeight: 'bold', color: '#007AFF', fontFamily: 'monospace' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: 'bold' },
  transferDetails: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F8FAFC', padding: 12, borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#EDF2F7' },
  userBox: { flex: 1 },
  userLabel: { fontSize: 11, color: '#64748B', marginBottom: 2 },
  userName: { fontSize: 13, fontWeight: '600', color: '#1E293B' },
  dateContainer: { borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingTop: 8 },
  dateText: { fontSize: 11, color: '#64748B', marginBottom: 2 }
});