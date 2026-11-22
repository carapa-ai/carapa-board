import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from 'typescript/unstable/ast';

const meaningfulComment =
  /(?:\/\/\/|\/\/[^\n]*(?:@|#__PURE__|eslint|istanbul|c8\s+ignore)|\/\*[\s\S]*?(?:@|#__PURE__|eslint|istanbul|c8\s+ignore)[\s\S]*?\*\/)/i;

// The scanner is not driven by the parser, so it never rescans regex literals,
// template continuations or JSX text. Their content is then tokenized as code
// and whitespace/comment-like text inside it looks insignificant. Any file
// containing such a token is never a semantic no-op.
const rescanKinds = new Set<SyntaxKind>([
  SyntaxKind.SlashToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);
const jsxKinds = new Set<SyntaxKind>([
  SyntaxKind.LessThanToken,
  SyntaxKind.LessThanSlashToken,
]);

function lex(source: string, jsx: boolean): string[] | undefined {
  // False positives are safe: they merely use the normal verification path.
  // Compiler/tool directives are comments syntactically but can change the
  // result, so never classify a file containing one as a semantic no-op.
  if (meaningfulComment.test(source)) return undefined;
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const lexemes: string[] = [];
  let first = true;
  let kind = scanner.scan();
  while (!Object.is(kind, SyntaxKind.EndOfFile)) {
    // Every non-EOF token consumes at least one UTF-16 code unit. This guard
    // turns scanner/API regressions into a conservative normal-verification
    // fallback instead of an unbounded allocation loop.
    if (lexemes.length >= source.length) return undefined;
    if (rescanKinds.has(kind) || (jsx && jsxKinds.has(kind))) return undefined;
    lexemes.push(
      `${first ? 0 : Number(scanner.hasPrecedingLineBreak())}:${kind}:${scanner.getTokenText()}`,
    );
    first = false;
    kind = scanner.scan();
  }
  return lexemes;
}

export function equivalentTypeScriptPrograms(
  before: string,
  after: string,
  file: string,
): boolean {
  const jsx = /\.[jt]sx$/.test(file);
  const beforeLexemes = lex(before, jsx);
  const afterLexemes = lex(after, jsx);
  return (
    beforeLexemes !== undefined &&
    afterLexemes !== undefined &&
    beforeLexemes.length === afterLexemes.length &&
    beforeLexemes.every((value, index) => Object.is(value, afterLexemes[index]))
  );
}

if (import.meta.main) {
  const [base, ...files] = process.argv.slice(2);
  if (!base || files.length === 0) process.exit(1);

  for (const file of files) {
    const previous = Bun.spawnSync(['git', 'show', `${base}:${file}`], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (previous.exitCode !== 0) process.exit(1);
    const current = await Bun.file(file)
      .text()
      .catch(() => undefined);
    if (
      current === undefined ||
      !equivalentTypeScriptPrograms(previous.stdout.toString(), current, file)
    ) {
      process.exit(1);
    }
  }
}
