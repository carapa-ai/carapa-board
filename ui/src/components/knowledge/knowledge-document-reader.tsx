import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ActiveTabContent,
  AuthenticatedDownloadLink,
} from '@/components/chat/preview-pane';
import { KnowledgeSourceLink } from './knowledge-source-link';
import { knowledgeFileContentUrl, type KnowledgeFile } from '@/lib/api';

export default function KnowledgeDocumentReader({
  kbId,
  file,
  onClose,
}: {
  kbId: string;
  file: KnowledgeFile;
  onClose: () => void;
}) {
  const url = knowledgeFileContentUrl(kbId, file.name);
  const title = file.name.split('/').pop() || file.name;
  return (
    <section
      data-ui="knowledge-document-reader"
      data-kb-id={kbId}
      data-document-path={file.name}
      aria-label={`Reading ${file.name}`}
      className="flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-3 sm:p-4">
        <Button variant="ghost" size="sm" onClick={onClose} autoFocus>
          <ArrowLeft className="size-4" /> Back to documents
        </Button>
        <h2
          className="min-w-0 flex-1 basis-40 truncate text-sm font-medium"
          title={file.name}
        >
          {file.name}
        </h2>
        <KnowledgeSourceLink sourceUrl={file.sourceUrl} className="shrink-0" />
        <AuthenticatedDownloadLink
          url={url}
          href={url}
          title={title}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-muted"
        >
          <Download className="size-3.5" /> Download
        </AuthenticatedDownloadLink>
      </div>
      <div
        className="min-h-0 flex-1 overflow-hidden"
        data-ui="knowledge-document-preview"
      >
        <ActiveTabContent
          key={file.name}
          tab={{
            id: file.name,
            title,
            kind: 'file',
            source: url,
            path: file.name,
            size: file.size,
          }}
          fetchUrl={url}
          project_id=""
          conversation_id={null}
        />
      </div>
    </section>
  );
}
