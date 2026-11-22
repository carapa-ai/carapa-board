import { useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Select, SelectItem } from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/page-header';
import { Volume2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'];
const FORMATS = ['ogg', 'wav', 'flac'];

function mime(fmt: string): string {
  return 'audio/' + (fmt === 'wav' ? 'wav' : fmt === 'flac' ? 'flac' : 'ogg');
}

function TtsTestPage() {
  const [text, setText] = useState(
    'Bună ziua. Aceasta este o probă de voce din carapa board. A doua propoziție, puțin mai lungă, ca să auzi streamingul.',
  );
  const [voice, setVoice] = useState('M1');
  const [lang, setLang] = useState('ro');
  const [format, setFormat] = useState('ogg');
  const [steps, setSteps] = useState(10);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const playerRef = useRef<HTMLAudioElement>(null);

  const addLog = (m: string) => setLog((l) => [...l, m]);
  const reqBody = () => JSON.stringify({ text, voice, lang, format, steps });

  async function synthesize() {
    setBusy(true);
    setLog([]);
    try {
      const r = await apiFetch(API_BASE_URL + '/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody(),
      });
      addLog(
        `status ${r.status} · duration ${r.headers.get('x-audio-duration') ?? '?'}s`,
      );
      if (!r.ok) {
        addLog(await r.text().catch(() => ''));
        toast.error(`TTS ${r.status}`);
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      if (playerRef.current) {
        playerRef.current.src = url;
        await playerRef.current.play().catch(() => {});
      }
    } catch (e: any) {
      addLog('error: ' + e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stream() {
    setBusy(true);
    setLog([]);
    const queue: string[] = [];
    let playing = false;
    const playNext = () => {
      const el = playerRef.current;
      if (!el || playing || queue.length === 0) return;
      playing = true;
      el.src = queue.shift()!;
      el.onended = () => {
        playing = false;
        playNext();
      };
      el.play().catch(() => {});
    };

    try {
      const res = await apiFetch(API_BASE_URL + '/api/tts/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody(),
      });
      addLog(`status ${res.status}`);
      if (!res.ok || !res.body) {
        addLog(await res.text().catch(() => ''));
        toast.error(`TTS ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const c = JSON.parse(line);
          if (c.error) {
            addLog('stream error: ' + c.error);
            continue;
          }
          addLog(
            `chunk ${c.index + 1}/${c.total} · ${(c.durationMs / 1000).toFixed(2)}s · ${c.text}`,
          );
          const bytes = Uint8Array.from(atob(c.audioBase64), (x) =>
            x.charCodeAt(0),
          );
          queue.push(
            URL.createObjectURL(new Blob([bytes], { type: mime(c.format) })),
          );
          playNext();
        }
      }
      addLog('stream complete');
    } catch (e: any) {
      addLog('error: ' + e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const selectCls = 'w-full';

  return (
    <div className="flex-1 h-full flex flex-col min-h-0">
      <PageHeader
        icon={
          <div className="p-2 bg-primary/10 rounded-lg shrink-0">
            <Volume2 className="size-5 text-primary" />
          </div>
        }
        title={<span className="font-semibold text-foreground">TTS test</span>}
        subtitle="Supertonic 3 · synthesize / pseudo-stream"
      />
      <div className="flex-1 overflow-auto p-4">
        <Card className="max-w-2xl mx-auto">
          <CardContent className="p-4 space-y-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Text</label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Voice</label>
                <Select
                  className={selectCls}
                  value={voice}
                  onValueChange={(nextValue) => setVoice(nextValue)}
                >
                  {VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Lang</label>
                <Input value={lang} onChange={(e) => setLang(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Format</label>
                <Select
                  className={selectCls}
                  value={format}
                  onValueChange={(nextValue) => setFormat(nextValue)}
                >
                  {FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Steps</label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={steps}
                  onChange={(e) => setSteps(parseInt(e.target.value, 10) || 10)}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <Button onClick={synthesize} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  'Synthesize'
                )}
              </Button>
              <Button variant="secondary" onClick={stream} disabled={busy}>
                Stream
              </Button>
            </div>

            <audio ref={playerRef} controls className="w-full" />

            {log.length > 0 && (
              <pre className="text-xs bg-muted/40 rounded-md p-3 whitespace-pre-wrap max-h-60 overflow-auto">
                {log.join('\n')}
              </pre>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/tts-test')({
  component: TtsTestPage,
});
