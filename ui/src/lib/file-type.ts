import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Globe,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

const ICON_GROUPS: [LucideIcon, string[]][] = [
  [
    FileText,
    [
      'md',
      'markdown',
      'mdx',
      'txt',
      'text',
      'log',
      'rst',
      'doc',
      'docx',
      'odt',
      'rtf',
      'pages',
    ],
  ],
  [FileSpreadsheet, ['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers']],
  [Presentation, ['ppt', 'pptx', 'odp', 'key']],
  [FileType, ['pdf']],
  [Globe, ['html', 'htm', 'xhtml']],
  [
    FileImage,
    [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'svg',
      'avif',
      'heic',
      'ico',
      'tif',
      'tiff',
    ],
  ],
  [FileAudio, ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']],
  [FileVideo, ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ogv']],
  [FileJson, ['json']],
  [
    FileCode,
    [
      'js',
      'mjs',
      'cjs',
      'jsx',
      'ts',
      'tsx',
      'css',
      'scss',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'php',
      'sh',
      'bash',
      'zsh',
      'sql',
      'yml',
      'yaml',
      'toml',
      'xml',
      'ini',
    ],
  ],
  [FileArchive, ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']],
];

const ICON_BY_EXTENSION = new Map<string, LucideIcon>(
  ICON_GROUPS.flatMap(([icon, extensions]) =>
    extensions.map((extension): [string, LucideIcon] => [extension, icon]),
  ),
);

/** Icon for a file name, chosen by extension; generic when unknown. */
export function fileIconFor(name: string): LucideIcon {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return File;
  return ICON_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? File;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
