import { createFileRoute } from '@tanstack/react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/layout/page-header';
import { PinSettings } from '@/components/account/pin-settings';
import { PinVaultSettings } from '@/components/account/pin-vault-settings';
import { DevicesTab } from '@/components/account/devices-tab';
import { ConnectAndroidCard } from '@/components/account/connect-android-card';
import { ConnectedClientsCard } from '@/components/account/connected-clients-card';
import { PreferencesCard } from '@/components/account/preferences-card';
import { AppearanceCard } from '@/components/account/appearance-card';
import { ThisDeviceCard } from '@/components/account/this-device-card';

function AccountPage() {
  const username = useAuth((s) => s.user?.username ?? null);

  return (
    <div className="flex-1 h-full flex flex-col min-h-0">
      <PageHeader
        icon={
          <div className="p-2 bg-primary/10 rounded-lg shrink-0">
            <UserCircle className="size-5 text-primary" />
          </div>
        }
        title={<span className="font-semibold text-foreground">Account</span>}
        subtitle={username ? `Signed in as ${username}` : undefined}
      />

      <ScrollArea className="flex-1 min-h-0 min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full">
        <div className="p-4 sm:p-6 max-w-3xl mx-auto w-full">
          <Tabs defaultValue="preferences" className="space-y-4">
            <TabsList>
              <TabsTrigger value="preferences">Preferences</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="mcp-clients">MCP clients</TabsTrigger>
            </TabsList>

            <TabsContent value="preferences" className="space-y-6">
              <AppearanceCard />
              <PreferencesCard />
            </TabsContent>

            <TabsContent value="security" className="space-y-6">
              <PinSettings />
              <PinVaultSettings />
            </TabsContent>

            <TabsContent value="devices" className="space-y-6">
              <ThisDeviceCard />
              <DevicesTab />
              <ConnectAndroidCard />
            </TabsContent>

            <TabsContent value="mcp-clients" className="space-y-6">
              <ConnectedClientsCard />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}

export const Route = createFileRoute('/account')({
  component: AccountPage,
});
