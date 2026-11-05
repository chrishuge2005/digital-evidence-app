import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { SearchBar } from '../../components/SearchBar';
import { VerificationStatusBadge } from '../../components/VerificationStatusBadge';
import { evidenceService } from '../../services/evidenceService';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../services/supabase';
import { safeFormatDate } from '../../utils/dateUtils';
import { Ionicons } from '@expo/vector-icons';

const PAGE_LIMIT = 20;

const CaseCard = React.memo(({ item, onPress }: { item: any; onPress: (id: string) => void }) => {
  const evidenceId = item.evidence_id || item.evidenceId;
  const dateStr = safeFormatDate(item.captured_at || item.capturedAt || item.created_at);
  const isPendingSync = item.syncStatus === 'PENDING' || item._syncStatus === 'PENDING' || item.uploadStatus === 'LOCAL_ONLY';

  return (
    <Pressable
      style={styles.card}
      onPress={() => onPress(evidenceId)}
    >
      <View style={styles.cardHeader}>
        <View style={styles.idRow}>
          <Text style={styles.evidenceId}>{evidenceId}</Text>
          {isPendingSync && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingBadgeText}>Pending Sync</Text>
            </View>
          )}
        </View>
        <VerificationStatusBadge status={item.verification_status || item.verificationStatus} />
      </View>
      <Text style={styles.cardTitle}>{item.title}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Status: {item.status || 'ACTIVE'}</Text>
        <Text style={styles.metaText}>Category: {item.category || 'N/A'}</Text>
      </View>
      <Text style={styles.dateText}>Captured: {dateStr}</Text>
    </Pressable>
  );
});

export default function OfficerEvidenceList() {
  const router = useRouter();
  const { user, team } = useAuth(); 
  const [teamId, setTeamId] = useState<string | null>(team?.teamId || null);
  
  // Scope, Search & Filter State
  const [viewScope, setViewScope] = useState<'ALL' | 'YOURS' | 'TRANSFERS'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('ALL');
  
  // Pagination & Data State
  const [evidenceList, setEvidenceList] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  // Request counter to ignore responses from stale async filter/tab requests
  const requestIdRef = useRef(0);

  // Sync teamId from AuthContext when available
  useEffect(() => {
    if (team?.teamId && team.teamId !== teamId) {
      setTeamId(team.teamId);
    }
  }, [team?.teamId]);

  // Fetch when Scope, Debounced Search, or Verification Filter change
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    loadTeamEvidenceData(1, true);
  }, [viewScope, searchQuery, verificationFilter, teamId]);

  // Reload when screen gains focus so newly captured or synced evidence is immediately visible
  useFocusEffect(
    useCallback(() => {
      loadTeamEvidenceData(1, true);
    }, [viewScope, searchQuery, verificationFilter, teamId, team?.teamId]) 
  );

  const loadTeamEvidenceData = async (pageNum = 1, shouldReset = false) => {
    const currentRequestId = ++requestIdRef.current;
    try {
      if (pageNum === 1 && !refreshing) setLoading(true);
      else if (pageNum > 1) setLoadingMore(true);

      let currentTeamId = teamId || team?.teamId;
      
      if (!currentTeamId && user) {
        try {
          const { data: memberData } = await supabase
            .from('team_members')
            .select('team_id')
            .eq('user_id', user.id)
            .eq('status', 'ACTIVE')
            .maybeSingle();

          if (memberData?.team_id) {
            currentTeamId = memberData.team_id;
            setTeamId(currentTeamId || null);
          }
        } catch (e) {
          console.warn('Could not fetch team member data (might be offline):', e);
        }
      }

      if (!user) {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const searchParams = {
        teamId: currentTeamId || undefined,
        query: searchQuery.trim(),
        status: undefined, 
        verificationStatus: verificationFilter,
        ownerId: user.id,
        scope: viewScope,
        page: pageNum,
        limit: PAGE_LIMIT
      };

      const res = await evidenceService.searchEvidence(searchParams);

      // Ignore response if another request was triggered in the meantime
      if (currentRequestId !== requestIdRef.current) {
        return;
      }

      const results = res.data || [];

      if (shouldReset) {
        setEvidenceList(results);
      } else {
        setEvidenceList(prev => {
          const combined = [...prev, ...results];
          return Array.from(
            new Map(combined.map((item: any) => [item.id || item.evidence_id || item.evidenceId, item])).values()
          );
        });
      }

      // Hard stop pagination if fewer items than PAGE_LIMIT or zero items returned
      setHasMore(results.length >= PAGE_LIMIT && results.length > 0);
      setIsOffline(!!res.isOffline);
    } catch (err: any) {
      console.error('Error loading team evidence:', err?.message || err);
      if (currentRequestId === requestIdRef.current) {
        setHasMore(false);
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    loadTeamEvidenceData(1, true);
  }, [teamId, viewScope, searchQuery, verificationFilter]);

  const loadMore = () => {
    if (hasMore && !loading && !loadingMore && !refreshing && evidenceList.length > 0) {
      const next = page + 1;
      setPage(next);
      loadTeamEvidenceData(next, false);
    }
  };

  const handlePress = useCallback((evidenceId: string) => {
    router.push({
      pathname: '/(officer)/evidence/[evidenceId]',
      params: { evidenceId }
    });
  }, [router]);

  const renderItem = useCallback(({ item }: { item: any }) => (
    <CaseCard item={item} onPress={handlePress} />
  ), [handlePress]);

  // Dynamic empty state titles and subtexts based on current scope, search, and status filter
  const getEmptyStateContent = () => {
    if (searchQuery.trim()) {
      return {
        title: 'No Matching Evidence',
        subtext: `No evidence records matched "${searchQuery.trim()}".`
      };
    }

    if (verificationFilter === 'PENDING') {
      return { title: 'No Pending Evidence', subtext: 'There is no pending evidence requiring verification.' };
    }
    if (verificationFilter === 'VERIFIED') {
      return { title: 'No Verified Evidence', subtext: 'There is no verified evidence under this view.' };
    }
    if (verificationFilter === 'REJECTED') {
      return { title: 'No Rejected Evidence', subtext: 'There is no rejected evidence under this view.' };
    }
    if (verificationFilter === 'INTEGRITY_FAILED') {
      return { title: 'No Integrity Failed Evidence', subtext: 'No evidence integrity check failures found.' };
    }

    switch (viewScope) {
      case 'YOURS':
        return { title: 'No Evidence Created By You', subtext: "You haven't created or uploaded any evidence yet." };
      case 'TRANSFERS':
        return { title: 'No Accepted Transfers', subtext: 'No accepted transferred evidence received.' };
      default:
        return { title: 'No Evidence Found', subtext: 'No evidence records available.' };
    }
  };

  const emptyContent = getEmptyStateContent();

  return (
    <ScreenContainer>
      <View style={styles.container}>
        {/* Header Row with Title and Add Evidence Button */}
        <View style={styles.headerRow}>
          <Text style={styles.title}>Evidence</Text>
          <Pressable 
            style={styles.addEvidenceButton} 
            onPress={() => router.push('/(officer)/add-evidence')}
          >
            <Ionicons name="add" size={18} color="#FFF" style={{ marginRight: 4 }} />
            <Text style={styles.addEvidenceText}>Add Evidence</Text>
          </Pressable>
        </View>

        {/* 1. Scope Tabs: All / Yours / Transfers */}
        <View style={styles.tabsContainer}>
          <Pressable 
            style={[styles.tabButton, viewScope === 'ALL' && styles.tabButtonActive]} 
            onPress={() => setViewScope('ALL')}
          >
            <Text style={[styles.tabText, viewScope === 'ALL' && styles.tabTextActive]}>All Evidence</Text>
          </Pressable>
          <Pressable 
            style={[styles.tabButton, viewScope === 'YOURS' && styles.tabButtonActive]} 
            onPress={() => setViewScope('YOURS')}
          >
            <Text style={[styles.tabText, viewScope === 'YOURS' && styles.tabTextActive]}>Your Evidence</Text>
          </Pressable>
          <Pressable 
            style={[styles.tabButton, viewScope === 'TRANSFERS' && styles.tabButtonActive]} 
            onPress={() => setViewScope('TRANSFERS')}
          >
            <Text style={[styles.tabText, viewScope === 'TRANSFERS' && styles.tabTextActive]}>Transfers</Text>
          </Pressable>
        </View>

        {/* 2. Reusable SearchBar with 300ms Debounce */}
        <SearchBar
          value={searchQuery}
          onSearch={setSearchQuery}
          placeholder="Search by ID, title, description..."
          debounceMs={300}
        />

        {/* 3. Horizontally Scrollable Verification Filter Chips */}
        <View style={styles.filtersWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
            {['ALL', 'PENDING', 'VERIFIED', 'REJECTED', 'INTEGRITY_FAILED'].map(filter => (
              <Pressable
                key={filter}
                style={[styles.filterChip, verificationFilter === filter && styles.filterChipActive]}
                onPress={() => setVerificationFilter(filter)}
              >
                <Text style={[styles.filterText, verificationFilter === filter && styles.filterTextActive]}>
                  {filter.replace('_', ' ')}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {isOffline && (
          <Text style={styles.offlineNotice}>⚠ Showing locally cached evidence records.</Text>
        )}

        {/* 4. Optimized Evidence FlatList */}
        {loading && page === 1 && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading evidence cases...</Text>
          </View>
        ) : evidenceList.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="folder-open-outline" size={48} color="#94A3B8" style={{ marginBottom: 10 }} />
            <Text style={styles.emptyTitle}>{emptyContent.title}</Text>
            <Text style={styles.emptySubtext}>{emptyContent.subtext}</Text>
          </View>
        ) : (
          <FlatList
            data={evidenceList}
            keyExtractor={(item) => item.id || item.evidence_id || item.evidenceId}
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews={true}
            contentContainerStyle={styles.listContainer}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListFooterComponent={loadingMore ? <ActivityIndicator size="small" color="#007AFF" style={styles.footerLoader} /> : null}
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748B', fontSize: 14 },
  
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  
  addEvidenceButton: { 
    flexDirection: 'row', 
    backgroundColor: '#007AFF', 
    paddingHorizontal: 12, 
    paddingVertical: 7, 
    borderRadius: 8, 
    alignItems: 'center',
    elevation: 1
  },
  addEvidenceText: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  
  tabsContainer: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 10, padding: 4, marginBottom: 12 },
  tabButton: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabButtonActive: { backgroundColor: '#FFF', elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  tabTextActive: { color: '#007AFF' },

  filtersWrapper: { marginBottom: 12, height: 36 },
  filterScroll: { flexDirection: 'row' },
  filterChip: { backgroundColor: '#F1F5F9', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 8, height: 32, justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  filterChipActive: { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  filterText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  filterTextActive: { color: '#FFF' },
  
  offlineNotice: { fontSize: 12, color: '#B45309', backgroundColor: '#FEF3C7', padding: 8, borderRadius: 6, marginBottom: 10, textAlign: 'center' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, marginTop: 40 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  emptySubtext: { fontSize: 13, color: '#64748B', textAlign: 'center' },
  footerLoader: { marginVertical: 16 },
  listContainer: { paddingBottom: 24 },
  
  card: {
    backgroundColor: '#FFF',
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
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  evidenceId: { fontSize: 13, fontWeight: 'bold', color: '#007AFF', fontFamily: 'monospace' },
  pendingBadge: { backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: '#FDE68A' },
  pendingBadgeText: { fontSize: 10, fontWeight: 'bold', color: '#B45309' },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 6 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  metaText: { fontSize: 12, color: '#64748B' },
  dateText: { fontSize: 11, color: '#94A3B8' }
});
