import * as nodePath from "node:path";

// Host side: `id` globs compiled to RegExps, which workers get as `{ source,
// flags }` (Bun folds them into its `onLoad` filter).

const SEP = String.raw`[\\/]`;
const SEGMENT_CHAR = String.raw`[^\\/]`;

/**
 * Resolve a glob from cwd unless it starts with `**` or is absolute (`..` and
 * `.` segments are normalized, `\` escapes kept). cwd is escaped, so glob
 * characters in it (`[`, `{`, ...) match literally.
 */
export function resolveGlob(
  pattern: string,
  cwd = process.cwd(),
  windows = process.platform === "win32",
): string {
  if (pattern.startsWith("**")) {
    return pattern;
  }
  if ((windows ? nodePath.win32 : nodePath.posix).isAbsolute(pattern)) {
    // A Windows path written with `\` separators only (`C:\app\*.ts`): they
    // can't be escapes there. With `/` separators, `\` stays an escape.
    return windows && !pattern.includes("/") ? pattern.replaceAll("\\", "/") : pattern;
  }
  const base = cwd.replaceAll("\\", "/").replace(/[*?[\]{}()!+@,\\]/g, "\\$&");
  return nodePath.posix.join(base, pattern);
}

/**
 * Compile a glob to an anchored RegExp matching `/`-separated ids (and
 * Windows paths: `/` in the glob matches either separator).
 *
 * - `*` matches within a path segment, `?` one character in it, both also
 *   dot files; `**` as a whole segment matches any number of segments
 *   (`src/**` needs something after `src/`), elsewhere it is `*`.
 * - `[abc]`, `[a-z]`, `[!abc]`/`[^abc]`; `{a,b}` (nested, single item too).
 * - `\` escapes the next character. Case-sensitive, no extglobs.
 */
export function globToRegExp(glob: string): RegExp {
  const closing = _braceMatches(glob);
  let source = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "\\" && i + 1 < glob.length) {
      source += _escape(glob[++i]!);
    } else if (char === "*") {
      if (glob[i + 1] !== "*") {
        source += `${SEGMENT_CHAR}*`;
        continue;
      }
      const wholeSegment =
        (i === 0 || glob[i - 1] === "/") && (i + 2 === glob.length || glob[i + 2] === "/");
      if (!wholeSegment) {
        source += `${SEGMENT_CHAR}*`;
      } else if (i + 2 === glob.length) {
        source += ".*";
      } else {
        // `**/`: zero or more segments.
        source += `(?:${SEGMENT_CHAR}*${SEP})*`;
        i++;
      }
      i++;
    } else if (char === "?") {
      source += SEGMENT_CHAR;
    } else if (char === "[" && glob.indexOf("]", i + 2) !== -1) {
      const end = glob.indexOf("]", i + 2);
      let body = glob.slice(i + 1, end);
      const negated = body[0] === "!" || body[0] === "^";
      if (negated) {
        body = body.slice(1);
      }
      source += `[${negated ? String.raw`^\\/` : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = end;
    } else if (char === "{" && closing.has(i)) {
      depth++;
      source += "(?:";
    } else if (char === "}" && depth > 0) {
      depth--;
      source += ")";
    } else if (char === "," && depth > 0) {
      source += "|";
    } else {
      source += char === "/" ? SEP : _escape(char);
    }
  }
  return new RegExp(`^${source}$`);
}

// Indices of `{` with a matching `}` (others are literal).
function _braceMatches(glob: string): Set<number> {
  const open: number[] = [];
  const matched = new Set<number>();
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "\\") {
      i++;
    } else if (glob[i] === "{") {
      open.push(i);
    } else if (glob[i] === "}" && open.length > 0) {
      matched.add(open.pop()!);
    }
  }
  return matched;
}

function _escape(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
