import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Select, SelectItem } from '@/components/ui/select';
import { useTheme, type ThemePreference } from '@/lib/theme';

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Appearance switcher. The preference is stored per device in localStorage
 * (lib/theme.ts), not in the server account preferences, so it applies before
 * the first paint and can differ between the phone and the desktop.
 */
export function AppearanceCard() {
  const { preference, setPreference } = useTheme();

  return (
    <Card data-ui="appearance-card">
      <CardContent className="space-y-4 p-6">
        <div className="space-y-1">
          <CardTitle className="text-base">Appearance</CardTitle>
          <p className="text-sm text-muted-foreground">
            Choose how CarapaBoard looks on this device. System follows your OS
            setting and updates live.
          </p>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Theme</span>
          <Select
            data-ui="theme-select"
            className="w-full"
            value={preference}
            onValueChange={(value) => setPreference(value as ThemePreference)}
          >
            {themeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </Select>
        </label>
      </CardContent>
    </Card>
  );
}
