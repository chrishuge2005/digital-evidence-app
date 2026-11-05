import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function OfficerLayout() {
  return (
    <Tabs 
      screenOptions={{ 
        tabBarActiveTintColor: '#007AFF',
        headerShown: false, // Globally removes the header for every page
      }}
    >
      {/* Visible Dashboard Tab */}
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
        }}
      />

      {/* Visible Evidence List Tab */}
      <Tabs.Screen
        name="evidence"
        options={{
          title: 'Evidence',
          tabBarIcon: ({ color, size }) => <Ionicons name="folder-outline" size={size} color={color} />,
        }}
      />

      {/* Visible Notifications Tab */}
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color, size }) => <Ionicons name="notifications-outline" size={size} color={color} />,
        }}
      />

      {/* Visible Verify Tab */}
      <Tabs.Screen
        name="verify"
        options={{
          title: 'Verify',
          tabBarIcon: ({ color, size }) => <Ionicons name="shield-checkmark-outline" size={size} color={color} />,
        }}
      />

      {/* Visible Profile Tab */}
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} />,
        }}
      />

      {/* Hidden: Add Evidence Form */}
      <Tabs.Screen
        name="add-evidence"
        options={{
          href: null,
          headerShown: false,
        }}
      />

      {/* Hidden: Evidence Details Dynamic Route */}
      <Tabs.Screen
        name="evidence/[evidenceId]"
        options={{
          href: null,
          headerShown: false,
        }}
      />

      <Tabs.Screen
        name="evidence/custody-history"
        options={{
          href: null,
          headerShown: false,
        }}
      />

      {/* === ADDED: Hidden Transfer Dynamic Route === */}
      <Tabs.Screen
        name="transfer/[id]"
        options={{
          href: null, // Hides it from the bottom tab bar completely
          headerShown: true,
          title: 'Transfer Evidence'
        }}
      />
    </Tabs>
  );
}