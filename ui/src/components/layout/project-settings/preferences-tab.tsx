import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { TabsContent } from '@/components/ui/tabs';
import { TAB_CONTENT_CLASS, type FormProps } from './shared';

interface PreferencesTabProps extends FormProps {
  memberPrefs: string;
  setMemberPrefs: (prefs: string) => void;
  pushPref: boolean | null;
  setPushPref: (pref: boolean | null) => void;
  pushEffective: boolean;
}

/** Per-(user, project) preferences; stored outside the ProjectSettings blob. */
export function PreferencesTab({
  form,
  setForm,
  memberPrefs,
  setMemberPrefs,
  pushPref,
  setPushPref,
  pushEffective,
}: PreferencesTabProps) {
  return (
    <TabsContent
      value="preferences"
      data-ui="project-settings-tab-preferences"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="settings-member-prefs"
          >
            Your Preferences for This Project
          </label>
          <Textarea
            id="settings-member-prefs"
            placeholder="e.g. Always reply in English on this project. Prefer concise answers."
            value={memberPrefs}
            onChange={(e) => setMemberPrefs(e.target.value)}
            rows={6}
          />
          <p className="text-xs text-muted-foreground">
            Personal, per-project notes appended to the system prompt for every
            chat you start here. Overrides your account-level preferences on
            conflict. Other members of this project see their own version.
          </p>
        </div>

        <div
          className="flex items-start space-x-2 border-t border-border pt-4"
          data-ui="tool-activity-display-setting"
        >
          <Checkbox
            id="settings-expand-tool-activity"
            checked={form.toolCallDisplay === 'expanded'}
            onCheckedChange={(checked) =>
              setForm({
                ...form,
                toolCallDisplay: checked ? 'expanded' : 'compact',
              })
            }
          />
          <div>
            <label
              htmlFor="settings-expand-tool-activity"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Expand tool activity by default
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Show full tool requests and results when chat opens. Leave
              unchecked for a compact summary that can still be expanded
              manually.
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-sm font-medium">Push Notifications</div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="settings-push-pref"
              checked={pushPref === true}
              onCheckedChange={(v) => setPushPref(v === true)}
            />
            <div className="flex-1 space-y-1">
              <label
                htmlFor="settings-push-pref"
                className="text-sm cursor-pointer"
              >
                Receive push notifications from this project
              </label>
              <p className="text-xs text-muted-foreground">
                {pushEffective
                  ? 'Currently receiving pushes from agents in this project.'
                  : 'Not currently receiving pushes from this project.'}{' '}
                Every project requires an explicit opt-in, including projects
                you own. The main group is opted in by default for everyone.
              </p>
              {pushPref !== null && (
                <button
                  type="button"
                  onClick={() => setPushPref(null)}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                >
                  Use default
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </TabsContent>
  );
}
