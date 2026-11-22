import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import {
  useKnowledgeFiles,
  useUploadKnowledgeFile,
  useDeleteKnowledgeFile,
  useKnowledgeTags,
  useKnowledgeSearch,
} from '@/hooks/use-knowledge';
import {
  apiFetch,
  getNativeBinaryDataUrl,
  knowledgeThumbnailUrl,
  type KnowledgeFile,
} from '@/lib/api';
import { KnowledgeItemGrid, KnowledgeItemCard } from './knowledge-items';
import { KnowledgeSourceLink } from './knowledge-source-link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchInput } from '@/components/ui/search-input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  FileText,
  Upload,
  RefreshCw,
  Folder,
  Tags,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryLoadState } from '@/lib/use-query-load-state';
import { cn } from '@/lib/utils';
import {
  KnowledgeDocumentTagEditor,
  KnowledgeTagFilter,
} from './document-tags';
import { confirmAction } from '@/components/confirm-dialog';

const KnowledgeDocumentReader = lazy(
  () => import('./knowledge-document-reader'),
);

type UploadFailure = { name: string; reason: string };

const MAX_LISTED_UPLOAD_FAILURES = 3;

const uploadFailureReason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function formatUploadFailures(failures: UploadFailure[]): {
  title: string;
  description?: string;
} {
  if (failures.length === 1) {
    return {
      title: `Failed to upload ${failures[0].name}: ${failures[0].reason}`,
    };
  }
  const lines = failures
    .slice(0, MAX_LISTED_UPLOAD_FAILURES)
    .map(({ name, reason }) => `${name}: ${reason}`);
  const hidden = failures.length - lines.length;
  if (hidden > 0) lines.push(`and ${hidden} more`);
  return {
    title: `Failed to upload ${failures.length} files`,
    description: lines.join('\n'),
  };
}

export function KnowledgeDocuments({ kbId }: { kbId: string }) {
  const filesQuery = useKnowledgeFiles(kbId);
  const files = filesQuery.data;
  const filesLoad = useQueryLoadState([filesQuery], {
    isEmpty: () => filesQuery.data?.length === 0,
  });
  const filesUnavailable = filesLoad.phase === 'error';
  const uploadMutation = useUploadKnowledgeFile();
  const deleteFileMutation = useDeleteKnowledgeFile();
  const { data: tagSuggestions = [], isError: tagsFailed } =
    useKnowledgeTags(kbId);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [verifySearch, setVerifySearch] = useState(false);
  const [readingFile, setReadingFile] = useState<KnowledgeFile | null>(null);
  const [editingTags, setEditingTags] = useState<KnowledgeFile | null>(null);
  const visibleFiles = files?.filter((file) =>
    selectedTags.every((selected) =>
      file.tags.some((tag) => tag.toLowerCase() === selected.toLowerCase()),
    ),
  );
  const searchQuery = useKnowledgeSearch(
    kbId,
    submittedSearch,
    selectedTags,
    verifySearch,
  );
  const isSearching = submittedSearch.length > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    const fileList = Array.from(selectedFiles);
    let successCount = 0;
    const failures: UploadFailure[] = [];

    for (const file of fileList) {
      const reader = new FileReader();
      const uploadPromise = new Promise<void>((resolve, reject) => {
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1];
          try {
            await uploadMutation.mutateAsync({
              id: kbId,
              name: file.name,
              content: base64,
            });
            successCount++;
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
      });

      try {
        await uploadPromise;
      } catch (err) {
        console.error(`Upload failed for ${file.name}:`, err);
        failures.push({ name: file.name, reason: uploadFailureReason(err) });
      }
    }

    if (successCount > 0) {
      toast.success(
        `Successfully uploaded ${successCount} file${successCount > 1 ? 's' : ''}`,
      );
    }
    if (failures.length > 0) {
      const { title, description } = formatUploadFailures(failures);
      toast.error(title, { description });
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileDelete = async (filename: string) => {
    const confirmed = await confirmAction(
      'The file and its thumbnail will be removed from this Knowledge Base.',
      {
        title: `Delete ${filename}?`,
        confirmLabel: 'Delete',
        destructive: true,
      },
    );
    if (!confirmed) return;
    try {
      await deleteFileMutation.mutateAsync({ id: kbId, filename });
      toast.success('File deleted');
    } catch (e: any) {
      toast.error(`Failed to delete file: ${e.message}`);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const items = Array.from(e.dataTransfer.items);
    if (items.length === 0) return;

    let successCount = 0;
    const failures: UploadFailure[] = [];

    const traverseEntry = async (entry: any, pathPrefix = '') => {
      if (entry.isFile) {
        try {
          const file = await new Promise<File>((resolve, reject) =>
            entry.file(resolve, reject),
          );
          const relativeName = pathPrefix
            ? `${pathPrefix}/${file.name}`
            : file.name;
          const reader = new FileReader();
          await new Promise<void>((resolve, reject) => {
            reader.onload = async () => {
              const base64 = (reader.result as string).split(',')[1];
              try {
                await uploadMutation.mutateAsync({
                  id: kbId,
                  name: relativeName,
                  content: base64,
                });
                successCount++;
                resolve();
              } catch (e) {
                console.error(`[Knowledge] Failed to upload ${file.name}:`, e);
                failures.push({
                  name: relativeName,
                  reason: uploadFailureReason(e),
                });
                resolve();
              }
            };
            reader.onerror = () => {
              console.error(`[Knowledge] Failed to read ${file.name}`);
              failures.push({
                name: relativeName,
                reason: `Failed to read ${file.name}`,
              });
              resolve();
            };
            reader.readAsDataURL(file);
          });
        } catch (err) {
          console.error(
            `[Knowledge] Error getting file from entry ${entry.name}:`,
            err,
          );
          failures.push({
            name: entry.name,
            reason: uploadFailureReason(err),
          });
        }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAllEntries = async () => {
          let allEntries: any[] = [];
          let batch: any[] = [];
          do {
            batch = await new Promise<any[]>((resolve, reject) => {
              reader.readEntries(resolve, reject);
            });
            allEntries = allEntries.concat(batch);
          } while (batch.length > 0);
          return allEntries;
        };

        try {
          const entries = await readAllEntries();
          for (const childEntry of entries) {
            const newPrefix = pathPrefix
              ? `${pathPrefix}/${entry.name}`
              : entry.name;
            await traverseEntry(childEntry, newPrefix);
          }
        } catch (err) {
          console.error(
            `[Knowledge] Error reading directory ${entry.name}:`,
            err,
          );
        }
      }
    };

    const promises = items.map((item) => {
      const entry = item.webkitGetAsEntry();
      if (entry) return traverseEntry(entry, '');
      return Promise.resolve();
    });

    await Promise.all(promises);

    if (successCount > 0) toast.success(`Uploaded ${successCount} files`);
    if (failures.length > 0) {
      const { title, description } = formatUploadFailures(failures);
      toast.error(title, { description });
    }
  };

  if (readingFile) {
    return (
      <Suspense
        fallback={
          <div role="status" className="p-4 text-sm text-muted-foreground">
            Loading document viewer…
          </div>
        }
      >
        <KnowledgeDocumentReader
          kbId={kbId}
          file={readingFile}
          onClose={() => setReadingFile(null)}
        />
      </Suspense>
    );
  }

  return (
    <ScrollArea
      data-ui="knowledge-document-area"
      data-kb-id={kbId}
      className="flex-1 min-w-0 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
    >
      <div className="p-4 sm:p-6">
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" /> Documents
              <span className="font-normal text-muted-foreground">
                {isSearching
                  ? searchQuery.isSuccess &&
                    `${searchQuery.data.length} results`
                  : !filesUnavailable && (visibleFiles?.length ?? 0)}
                {!isSearching &&
                  !filesUnavailable &&
                  selectedTags.length > 0 &&
                  ` / ${files?.length ?? 0}`}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5 h-7"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
              >
                <Upload className="size-3" />
                Upload
              </Button>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                onChange={handleFileUpload}
                multiple
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            For a thumbnail, upload an image with the same base name as the
            document, such as article.md and article.jpg.
          </p>
          <>
            <form
              data-ui="knowledge-search"
              className="mb-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                setSubmittedSearch(searchInput.trim());
              }}
            >
              <SearchInput
                aria-label="Search this knowledge base"
                placeholder="Search this knowledge base…"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                wrapperClassName="flex-1"
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={!searchInput.trim()}
              >
                Search
              </Button>
              {isSearching && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSearchInput('');
                    setSubmittedSearch('');
                  }}
                >
                  Clear
                </Button>
              )}
            </form>
            <label
              data-ui="knowledge-search-verifier"
              className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Checkbox
                checked={verifySearch}
                onCheckedChange={(checked) => setVerifySearch(checked === true)}
              />
              <span>
                Use LLM precision verification{' '}
                <span className="text-muted-foreground/70">(slower)</span>
              </span>
            </label>
            <KnowledgeTagFilter
              tags={tagSuggestions}
              selected={selectedTags}
              onChange={setSelectedTags}
            />
            {tagsFailed && (
              <p role="alert" className="text-xs text-destructive mb-2">
                Could not load tag suggestions.
              </p>
            )}
            {isSearching ? (
              <KnowledgeSearchResults
                query={submittedSearch}
                results={searchQuery.data}
                isLoading={searchQuery.isLoading}
                isError={!!searchQuery.error}
              />
            ) : (
              <div
                className={cn(
                  'rounded-xl border-2 border-dashed transition-colors',
                  isDragging
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent',
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {filesLoad.phase === 'loading' ? (
                  <div className="py-8 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
                    <RefreshCw className="size-4 animate-spin opacity-50" />
                    Loading documents...
                  </div>
                ) : filesUnavailable ? (
                  <div
                    data-ui="knowledge-documents-error"
                    role="alert"
                    className="py-12 text-center text-xs text-muted-foreground flex flex-col items-center gap-3"
                  >
                    <AlertCircle className="size-8 opacity-30" />
                    <div>
                      <p className="font-medium">Could not load documents</p>
                      <p className="opacity-60">
                        {filesLoad.error?.message ||
                          'Something went wrong while loading documents.'}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-7"
                      disabled={filesLoad.isRetrying}
                      onClick={filesLoad.retry}
                    >
                      {filesLoad.isRetrying && (
                        <RefreshCw className="size-3 animate-spin" />
                      )}
                      Retry
                    </Button>
                  </div>
                ) : filesLoad.phase === 'empty' ? (
                  <div className="py-12 text-center text-xs text-muted-foreground flex flex-col items-center gap-3">
                    <FileText className="size-8 opacity-20" />
                    <div>
                      <p className="font-medium">No documents yet</p>
                      <p className="opacity-60">
                        Upload or drag & drop files here.
                      </p>
                    </div>
                  </div>
                ) : (
                  <KnowledgeItemGrid data-ui="knowledge-documents">
                    {filesLoad.staleError && (
                      <div
                        role="alert"
                        className="col-span-full flex items-center justify-between gap-3 text-xs text-destructive"
                      >
                        <span className="min-w-0">
                          Could not refresh documents:{' '}
                          {filesLoad.staleError.message}
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          className="h-7 shrink-0"
                          disabled={filesLoad.isRetrying}
                          onClick={filesLoad.retry}
                        >
                          {filesLoad.isRetrying && (
                            <RefreshCw className="size-3 animate-spin" />
                          )}
                          Retry
                        </Button>
                      </div>
                    )}
                    {filesQuery.isSuccess && !visibleFiles?.length && (
                      <p
                        className="col-span-full py-8 text-center text-sm text-muted-foreground"
                        role="status"
                      >
                        No documents match all selected tags.
                      </p>
                    )}
                    {visibleFiles?.map((file) => (
                      <KnowledgeItemCard
                        key={file.name}
                        data-ui="knowledge-document"
                        data-document-path={file.name}
                      >
                        {file.thumbnail && (
                          <button
                            type="button"
                            className="w-full text-left focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Preview ${file.name}`}
                            onClick={() => setReadingFile(file)}
                          >
                            <DocumentThumbnail
                              key={`${file.name}:${file.thumbnail.mtime}`}
                              kbId={kbId}
                              file={file}
                            />
                          </button>
                        )}
                        <div className="p-3 sm:p-4 flex flex-col gap-3 flex-1">
                          <div className="flex items-start gap-2.5 min-w-0">
                            <div className="p-1.5 bg-primary/10 rounded shrink-0">
                              <FileText className="size-4 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3
                                className="text-sm font-semibold line-clamp-2 break-words [overflow-wrap:anywhere] leading-snug"
                                title={file.name}
                              >
                                <button
                                  type="button"
                                  className="text-left hover:text-primary hover:underline focus-visible:underline outline-none"
                                  aria-label={`Read ${file.name}`}
                                  onClick={() => setReadingFile(file)}
                                >
                                  {file.title || file.name.split('/').pop()}
                                </button>
                              </h3>
                              {file.title && (
                                <p
                                  data-ui="knowledge-document-filename"
                                  className="text-xs text-muted-foreground truncate mt-0.5"
                                >
                                  {file.name.split('/').pop()}
                                </p>
                              )}
                              {file.description && (
                                <p
                                  data-ui="knowledge-document-description"
                                  className="text-xs text-muted-foreground truncate mt-1"
                                >
                                  {file.description}
                                </p>
                              )}
                              <KnowledgeSourceLink
                                sourceUrl={file.sourceUrl}
                                className="mt-1"
                              />
                              {file.name.includes('/') && (
                                <p
                                  className="text-xs text-muted-foreground truncate mt-1"
                                  title={file.name}
                                >
                                  <Folder className="inline size-3 mr-1" />
                                  {file.name.split('/').slice(0, -1).join('/')}
                                </p>
                              )}
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0"
                              aria-label={`Edit tags for ${file.name}`}
                              title="Edit tags"
                              onClick={() => setEditingTags(file)}
                            >
                              <Tags className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0 text-muted-foreground hover:text-destructive"
                              aria-label={`Delete ${file.name}`}
                              onClick={() => handleFileDelete(file.name)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                          <div
                            data-ui="knowledge-document-tags"
                            className="flex flex-wrap gap-1"
                          >
                            {file.tags.map((tag) => (
                              <Badge
                                key={tag.toLowerCase()}
                                variant="secondary"
                                className="max-w-full whitespace-normal font-normal text-xs text-muted-foreground"
                              >
                                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                                  {tag}
                                </span>
                              </Badge>
                            ))}
                            {!file.tags.length && (
                              <span className="text-xs text-muted-foreground">
                                No tags
                              </span>
                            )}
                          </div>
                          <div
                            data-ui="knowledge-document-footer"
                            className="flex flex-wrap gap-x-2 gap-y-0.5 justify-between border-t border-border/40 pt-2 mt-auto text-[10px] text-muted-foreground"
                          >
                            <span>{(file.size / 1024).toFixed(1)} KB</span>
                            <span
                              data-ui="knowledge-document-dates"
                              className="flex flex-wrap justify-end gap-x-2"
                            >
                              {file.publishedAt && (
                                <span title="Published">
                                  Published{' '}
                                  {new Date(
                                    file.publishedAt,
                                  ).toLocaleDateString()}
                                </span>
                              )}
                              <span title="Added to the knowledge base">
                                Added{' '}
                                {new Date(file.addedAt).toLocaleDateString()}
                              </span>
                            </span>
                          </div>
                        </div>
                      </KnowledgeItemCard>
                    ))}
                  </KnowledgeItemGrid>
                )}
              </div>
            )}
          </>
          <Dialog
            open={!!editingTags}
            onOpenChange={(open) => {
              if (!open) setEditingTags(null);
            }}
          >
            {editingTags && (
              <KnowledgeDocumentTagEditor
                key={editingTags.name}
                kbId={kbId}
                file={editingTags}
                suggestions={tagSuggestions}
                onSaved={() => setEditingTags(null)}
              />
            )}
          </Dialog>
        </section>
      </div>
    </ScrollArea>
  );
}

function KnowledgeSearchResults({
  query,
  results,
  isLoading,
  isError,
}: {
  query: string;
  results:
    | Array<{
        id: string;
        content: string;
        metadata: { source?: string; tags?: string[] };
        score?: number;
      }>
    | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <div
        data-ui="knowledge-search-results"
        className="py-8 text-center text-sm text-muted-foreground"
      >
        <RefreshCw className="mx-auto mb-2 size-4 animate-spin" />
        Searching indexed content…
      </div>
    );
  }
  if (isError) {
    return (
      <p
        data-ui="knowledge-search-results"
        role="alert"
        className="py-8 text-center text-sm text-destructive"
      >
        Search failed. Check the knowledge-base service and try again.
      </p>
    );
  }
  if (!results?.length) {
    return (
      <p
        data-ui="knowledge-search-results"
        role="status"
        className="py-8 text-center text-sm text-muted-foreground"
      >
        No results found for “{query}”.
      </p>
    );
  }
  return (
    <div data-ui="knowledge-search-results" className="space-y-3">
      {results.map((result) => (
        <article
          key={result.id}
          data-ui="knowledge-search-result"
          data-source={result.metadata.source || undefined}
          className="rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {result.metadata.source || 'Unknown source'}
            </span>
            {typeof result.score === 'number' && (
              <span>Score {(result.score * 100).toFixed(0)}%</span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {result.content}
          </p>
          {!!result.metadata.tags?.length && (
            <div className="mt-3 flex flex-wrap gap-1">
              {result.metadata.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="font-normal text-xs"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function DocumentThumbnail({
  kbId,
  file,
}: {
  kbId: string;
  file: KnowledgeFile;
}) {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string>();
  const containerRef = useRef<HTMLDivElement>(null);
  const url = knowledgeThumbnailUrl(kbId, file);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    // Module routes require device signatures even for browser image requests.
    const load = async () => {
      try {
        const response = await apiFetch(url);
        if (!response.ok) throw new Error('Thumbnail unavailable');
        const native = getNativeBinaryDataUrl(response);
        const blob = native ? null : await response.blob();
        if (cancelled) return;
        objectUrl = blob ? URL.createObjectURL(blob) : undefined;
        setSrc(native?.url ?? objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: '256px' },
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  if (failed) return null;
  return (
    <div
      ref={containerRef}
      data-ui="knowledge-document-thumbnail"
      className="aspect-video overflow-hidden bg-muted/30 border-b border-border/40"
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        className="size-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
