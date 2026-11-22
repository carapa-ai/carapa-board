import { useId, useState } from 'react';
import { Tags, X } from 'lucide-react';
import { toast } from 'sonner';
import type { KnowledgeFile, KnowledgeTag } from '@/lib/api';
import { useUpdateKnowledgeFileTags } from '@/hooks/use-knowledge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const tagKey = (tag: string) => tag.trim().toLowerCase();

export function KnowledgeTagFilter({
  tags,
  selected,
  onChange,
}: {
  tags: KnowledgeTag[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  return (
    <div
      data-ui="knowledge-tag-filter"
      className="mb-3 flex flex-wrap items-center gap-2 min-w-0"
    >
      <Dialog>
        <DialogTrigger asChild>
          <Button size="xs" variant="outline" className="gap-1.5">
            <Tags className="size-3" /> Filter by tags
            {selected.length > 0 && ` (${selected.length})`}
          </Button>
        </DialogTrigger>
        <DialogContent
          className="w-72 max-w-[calc(100vw-2rem)] space-y-3"
          data-ui="knowledge-tag-options"
        >
          <DialogHeader>
            <DialogTitle>Filter by tags</DialogTitle>
            <DialogDescription>
              Documents must match all selected tags.
            </DialogDescription>
          </DialogHeader>
          <SearchInput
            aria-label="Find tags"
            placeholder="Find tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-52 overflow-y-auto space-y-2">
            {tags
              .filter((tag) => tagKey(tag.name).includes(tagKey(search)))
              .map((tag) => (
                <label
                  key={tagKey(tag.name)}
                  className="flex items-start gap-2 text-sm cursor-pointer"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={selected.some(
                      (name) => tagKey(name) === tagKey(tag.name),
                    )}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...selected, tag.name]
                          : selected.filter(
                              (name) => tagKey(name) !== tagKey(tag.name),
                            ),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                    {tag.name}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {tag.count}
                  </span>
                </label>
              ))}
            {!tags.length && (
              <p className="text-xs text-muted-foreground">
                No tags yet. Add tags to a document to get started.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {selected.map((tag) => (
        <Badge
          key={tagKey(tag)}
          variant="secondary"
          className="max-w-full whitespace-normal gap-1 font-normal"
        >
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {tag}
          </span>
          <button
            type="button"
            aria-label={`Remove filter ${tag}`}
            className="shrink-0"
            onClick={() =>
              onChange(selected.filter((name) => tagKey(name) !== tagKey(tag)))
            }
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {selected.length > 0 && (
        <Button size="xs" variant="ghost" onClick={() => onChange([])}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

export function KnowledgeDocumentTagEditor({
  kbId,
  file,
  suggestions,
  onSaved,
}: {
  kbId: string;
  file: KnowledgeFile;
  suggestions: KnowledgeTag[];
  onSaved: () => void;
}) {
  const [tags, setTags] = useState(file.tags);
  const [input, setInput] = useState('');
  const suggestionId = useId();
  const mutation = useUpdateKnowledgeFileTags();
  const withInput = () => {
    const value = input.trim();
    if (!value || tags.some((tag) => tagKey(tag) === tagKey(value)))
      return tags;
    const existing = suggestions.find(
      (tag) => tagKey(tag.name) === tagKey(value),
    );
    return [...tags, existing?.name || value];
  };
  const save = async () => {
    try {
      await mutation.mutateAsync({
        id: kbId,
        filename: file.name,
        tags: withInput(),
      });
      toast.success('Document tags updated');
      onSaved();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update tags',
      );
    }
  };
  return (
    <DialogContent
      data-ui="knowledge-document-tag-editor"
      data-document-path={file.name}
      className="sm:max-w-md"
    >
      <DialogHeader>
        <DialogTitle>Edit document tags</DialogTitle>
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {file.name}
        </DialogDescription>
      </DialogHeader>
      <fieldset disabled={mutation.isPending} className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Badge
              key={tagKey(tag)}
              variant="secondary"
              className="max-w-full whitespace-normal gap-1 font-normal"
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {tag}
              </span>
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                className="shrink-0"
                onClick={() =>
                  setTags(tags.filter((name) => tagKey(name) !== tagKey(tag)))
                }
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          {!tags.length && (
            <p className="text-sm text-muted-foreground">No tags assigned.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Add a tag"
            list={suggestionId}
            placeholder="Choose or type a tag…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setTags(withInput());
                setInput('');
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!input.trim()}
            onClick={() => {
              setTags(withInput());
              setInput('');
            }}
          >
            Add
          </Button>
          <datalist id={suggestionId}>
            {suggestions.map((tag) => (
              <option key={tagKey(tag.name)} value={tag.name} />
            ))}
          </datalist>
        </div>
      </fieldset>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={onSaved}
        >
          Cancel
        </Button>
        <Button disabled={mutation.isPending} onClick={save}>
          {mutation.isPending ? 'Saving…' : 'Save tags'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
