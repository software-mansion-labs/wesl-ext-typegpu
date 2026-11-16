import type { AliasElem, DeclIdentElem, StructElem } from 'wesl';

/** A range of offsets into a module's source, as carried by every WESL AST element. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Thrown by the type and attribute translation code when it meets something it cannot express in TypeGPU.
 * It only knows which AST element is at fault; the struct translation code catches it and turns it into a
 * {@link TypeDeclTranslationError} that also says which file, declaration and member it happened in.
 */
export class TranslationError extends Error {
  /** The AST element at fault, filled in by the innermost code that knows it. */
  span: Span | undefined;

  constructor(message: string, span?: Span) {
    super(message);
    this.name = 'TranslationError';
    this.span = span;
  }
}

/**
 * Thrown when a WGSL expression has no JS equivalent we can emit.
 * `translateExpression` attaches the innermost expression it failed on, and callers add the context
 * (struct, member, const) the expression came from.
 */
export class UntranslatableExpressionError extends TranslationError {
  constructor(message: string, span?: Span) {
    super(message, span);
    this.name = 'UntranslatableExpressionError';
  }
}

/** Where in a WESL module an error happened. */
export interface ErrorLocation {
  /** Path of the module file, for display (e.g. `./main.wesl`). */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/** A struct or alias of a WESL module that could not be translated into a TypeGPU schema. */
export class TypeDeclTranslationError extends Error {
  readonly declName: string;
  readonly memberName: string | undefined;
  readonly location: ErrorLocation;
  /** The declaration whose translation actually failed, which is this one unless it depends on a broken one. */
  readonly rootDeclName: string;

  constructor(options: {
    decl: StructElem | AliasElem;
    memberName?: string;
    span: Span;
    reason: string;
    rootDeclName?: string;
    cause?: unknown;
  }) {
    const { decl, memberName, span, reason } = options;
    const declName = decl.name.ident.originalName;
    const location = locate(decl, span.start);
    const subject = memberName
      ? `${decl.kind} '${declName}', member '${memberName}'`
      : `${decl.kind} '${declName}'`;
    super(
      `${formatLocation(location)}: Cannot translate ${subject}: ${reason}`,
      { cause: options.cause },
    );
    this.name = 'TypeDeclTranslationError';
    this.declName = declName;
    this.memberName = memberName;
    this.location = location;
    this.rootDeclName = options.rootDeclName ?? declName;
  }
}

/** A failure that affects the whole module, e.g. an unresolvable module or cyclic struct definitions. */
export class ModuleTranslationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModuleTranslationError';
  }
}

/** Describes the source text of `span` in a message, if it's short enough to be readable. */
export function quoteSource(src: string, span: Span): string {
  const text = src.substring(span.start, span.end);
  if (text.length === 0 || text.length > 80 || text.includes('\n')) {
    return '';
  }
  return ` in '${text}'`;
}

export function locate(
  decl: Pick<StructElem | AliasElem, 'name'> | { name: DeclIdentElem },
  offset: number,
): ErrorLocation {
  const { debugFilePath, src } = decl.name.srcModule;
  const [line, column] = offsetToLineColumn(src, offset);
  return { file: debugFilePath, line, column };
}

export function formatLocation({ file, line, column }: ErrorLocation): string {
  return `${file}:${line}:${column}`;
}

function offsetToLineColumn(src: string, offset: number): [number, number] {
  const before = src.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return [line, column];
}
