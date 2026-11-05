import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';

export default function HigherOfficerLayout() {
  return (
    <Tabs 
      screenOptions={{ 
        tabBarActiveTintColor: '#34C759', 
        headerShown: false // Removes the header globally for all tabs
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: ({ color }) => <Ionicons name="home-outline" size={24} color={color} /> }} />
      <Tabs.Screen name="team" options={{ title: 'Team', tabBarIcon: ({ color }) => <Ionicons name="people-outline" size={24} color={color} /> }} />
      <Tabs.Screen name="cases" options={{ title: 'Cases', tabBarIcon: ({ color }) => <Ionicons name="briefcase-outline" size={24} color={color} /> }} />
      <Tabs.Screen name="verify" options={{ title: 'Verify', tabBarIcon: ({ color }) => <Ionicons name="shield-checkmark-outline" size={24} color={color} /> }} />
      <Tabs.Screen name="notifications" options={{ title: 'Notifications', tabBarIcon: ({ color }) => <Ionicons name="notifications-outline" size={24} color={color} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color }) => <Ionicons name="person-outline" size={24} color={color} /> }} />
      
      {/* Hidden route for evidence details */}
      <Tabs.Screen 
        name="evidence/[evidenceId]" 
        options={{ 
          href: null, 
          headerShown: false 
        }} 
      />

      {/* Hidden route for officer details drill-down */}
      <Tabs.Screen 
        name="officer-details" 
        options={{ 
          href: null, 
          headerShown: false 
        }} 
      />
      <Tabs.Screen 
        name="audit" 
        options={{ 
          href: null, 
          headerShown: false 
        }} 
      />
    </Tabs>
  );
}