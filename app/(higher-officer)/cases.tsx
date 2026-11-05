import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { higherOfficerService } from '../../services/higherOfficerService';
import { evidenceService } from '../../services/evidenceService';
import { VerificationStatusBadge } from '../../components/VerificationStatusBadge';
import { SearchBar } from '../../components/SearchBar';
import { useAuth } from '../../contexts/AuthContext';
import { safeFormatDate } from '../../utils/dateUtils';

const PAGE_LIMIT = 20;

const CaseCard = React.memo(({ item, onPress }: { item: any; onPress: (id: string) => void }) => {
  const evidenceId = item.evidence_id || item.evidenceId;
  const dateStr = safeFormatDate(item.captured_at || item.capturedAt || item.created_at);
  const officerName = item.officer_name || item.owner_name || item.creator_name || null;

  return (
    <Pressable
      style={styles.card}
      onPress={() => onPress(evidenceId)}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.evidenceId}>{evidenceId}</Text>
        <VerificationStatusBadge status={item.verification_status || item.verificationStatus} />
      </View>
      <Text style={styles.cardTitle}>{item.title}</Text>
      {officerName && (
        <Text style={styles.officerText}>
          Officer: <Text style={styles.officerName}>{officerName}</Text>
          {item.badge_number ? ` (Badge: ${item.badge_number})` : ''}
        </Text>
      )}
      <Text style={styles.metaText}>Status: {item.status}</Text>
      <Text style={styles.metaText}>Category: {item.category || 'N/A'}</Text>
      <Text style={styles.metaText}>Captured: {dateStr}</Text>
    </Pressable>
  );
});

export default function HOCases() {
  const router = useRouter();
  const { user, profile, team } = useAuth();
  const [teamId, setTeamId] = useState<string | null>(team?.teamId || null);
  
  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  
  // Pagination & Data State
  const [evidenceList, setEvidenceList] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  // Request counter to ignore responses from stale async filter requests
  const requestIdRef = useRef(0);

  // Sync teamId from AuthContext when available
  useEffect(() => {
    if (team?.teamId && team.teamId !== teamId) {
      setTeamId(team.teamId);
    }
  }, [team?.teamId]);

  // Fetch when Search (debounced natively by SearchBar) or Filters change
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    setEvidenceList([]);
    loadTeamEvidenceData(1, true);
  }, [searchQuery, verificationFilter, statusFilter, teamId]);

  // Refetch when screen gains focus
  useFocusEffect(
    useCallback(() => {
      loadTeamEvidenceData(1, true);
    }, [searchQuery, verificationFilter, statusFilter, teamId, team?.teamId])
  );

  const loadTeamEvidenceData = async (pageNum = 1, shouldReset = false) => {
    const currentRequestId = ++requestIdRef.current;
    try {
      if (pageNum === 1 && !refreshing) setLoading(true);
      else if (pageNum > 1) setLoadingMore(true);

      let currentTeamId = teamId || team?.teamId;
      if (!currentTeamId) {
        try {
          const { team: fetchedTeam } = await higherOfficerService.getTeamDashboardData();
          currentTeamId = fetchedTeam?.id || null;
          if (currentTeamId) {
            setTeamId(currentTeamId);
          }
        } catch (e) {
          console.warn('Could not load team dashboard data:', e);
        }
      }

      if (!currentTeamId) {
        setEvidenceList([]);
        setHasMore(false);
        return;
      }

      const res = await evidenceService.searchEvidence({
        teamId: currentTeamId,
        query: searchQuery,
        status: statusFilter,
        verificationStatus: verificationFilter,
        page: pageNum,
        limit: PAGE_LIMIT
      });

      // Ignore response if another request was triggered in the meantime
      if (currentRequestId !== requestIdRef.current) {
        return;
      }

      const fetchedData = res.data || [];

      if (shouldReset) {
        setEvidenceList(fetchedData);
      } else {
        setEvidenceList(prev => {
          const combined = [...prev, ...fetchedData];
          return Array.from(
            new Map(combined.map((item: any) => [item.id || item.evidence_id || item.evidenceId, item])).values()
          );
        });
      }

      // Hard stop pagination if fewer items than PAGE_LIMIT or zero items returned
      setHasMore(fetchedData.length >= PAGE_LIMIT && fetchedData.length > 0);
      setIsOffline(!!res.isOffline);
    } catch (err) {
      console.error('Error loading team cases:', err);
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

  // Explicit Pull-to-Refresh implementation
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    loadTeamEvidenceData(1, true);
  }, [teamId, searchQuery, statusFilter, verificationFilter]);

  const loadMore = () => {
    if (hasMore && !loading && !loadingMore && !refreshing && evidenceList.length > 0) {
      const next = page + 1;
      setPage(next);
      loadTeamEvidenceData(next, false);
    }
  };

  // Dynamic empty state message per verification filter
  const getEmptyMessage = () => {
    if (searchQuery.trim()) {
      return `No evidence found matching "${searchQuery.trim()}".`;
    }
    switch (verificationFilter) {
      case 'PENDING':
        return 'No Pending Evidence';
      case 'VERIFIED':
        return 'No Verified Evidence';
      case 'REJECTED':
        return 'No Rejected Evidence';
      case 'INTEGRITY_FAILED':
        return 'No Integrity Failed Evidence';
      default:
        return 'No Evidence Found';
    }
  };

  const handlePress = useCallback((evidenceId: string) => {
    router.push({
      pathname: '/(higher-officer)/evidence/[evidenceId]',
      params: { evidenceId }
    });
  }, [router]);

  const renderItem = useCallback(({ item }: { item: any }) => (
    <CaseCard item={item} onPress={handlePress} />
  ), [handlePress]);

  if (loading && evidenceList.length === 0 && !teamId) {
    return (
      <ScreenContainer style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading team cases...</Text>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <Text style={styles.title}>Team Cases</Text>

        <View style={styles.searchContainer}>
          <SearchBar 
            value={searchQuery}
            onSearch={setSearchQuery} 
            placeholder="Search by ID, title, description..."
          />
        </View>

        {/* Filters */}
        <View style={styles.filtersWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
            {/* Status Filters: ONLY Active and All Status */}
            <Pressable style={[styles.filterChip, statusFilter === 'ACTIVE' && styles.filterChipActive]} onPress={() => setStatusFilter('ACTIVE')}>
              <Text style={[styles.filterText, statusFilter === 'ACTIVE' && styles.filterTextActive]}>Active</Text>
            </Pressable>
            <Pressable style={[styles.filterChip, statusFilter === 'ALL' && styles.filterChipActive]} onPress={() => setStatusFilter('ALL')}>
              <Text style={[styles.filterText, statusFilter === 'ALL' && styles.filterTextActive]}>All Status</Text>
            </Pressable>
            
            <View style={styles.divider} />

            {/* Verification Filters: ALL, PENDING, VERIFIED, INTEGRITY FAILED */}
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
          <Text style={styles.offlineNotice}>⚠ Showing locally cached search results.</Text>
        )}

        {/* Evidence List */}
        {loading && page === 1 ? (
          <ActivityIndicator size="large" color="#007AFF" style={styles.loader} />
        ) : evidenceList.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>{getEmptyMessage()}</Text>
          </View>
        ) : (
          <FlatList
            data={evidenceList}
            keyExtractor={(item) => item.id || item.evidence_id || item.evidenceId}
            showsVerticalScrollIndicator={false}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews={true}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListFooterComponent={loadingMore ? <ActivityIndicator size="small" color="#007AFF" style={styles.footerLoader} /> : null}
            renderItem={renderItem}
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  center: { justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 16 },
  loadingText: { marginTop: 10, color: '#666' },
  searchContainer: { marginBottom: 12 },
  filtersWrapper: { marginBottom: 16, height: 40 },
  filterScroll: { flexDirection: 'row' },
  filterChip: { backgroundColor: '#E2E8F0', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginRight: 8, height: 36, justifyContent: 'center' },
  filterChipActive: { backgroundColor: '#007AFF' },
  filterText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  filterTextActive: { color: '#FFF' },
  divider: { width: 1, backgroundColor: '#CBD5E1', marginHorizontal: 4, height: 24, alignSelf: 'center', marginRight: 12 },
  offlineNotice: { fontSize: 12, color: '#B45309', backgroundColor: '#FEF3C7', padding: 8, borderRadius: 6, marginBottom: 12, textAlign: 'center' },
  emptyState: { padding: 20, backgroundColor: '#FFF', borderRadius: 12, elevation: 1, alignItems: 'center', marginTop: 40 },
  emptyText: { fontSize: 15, color: '#888', fontStyle: 'italic', textAlign: 'center' },
  loader: { marginTop: 40 },
  footerLoader: { margin: 20 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, elevation: 1 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  evidenceId: { fontSize: 13, fontWeight: 'bold', color: '#007AFF', fontFamily: 'monospace' },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  officerText: { fontSize: 12, color: '#475569', marginBottom: 4 },
  officerName: { fontWeight: '600', color: '#0F172A' },
  metaText: { fontSize: 12, color: '#64748B', marginBottom: 2 }
});
