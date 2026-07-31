export type StructuredTestInvocation = {
  key: string;
  suite: string;
};

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      segment += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      segment += character;
      continue;
    }
    const next = command[index + 1];
    const isBoundary =
      character === "\n" ||
      character === ";" ||
      character === "|" ||
      (character === "&" && next === "&");
    if (!isBoundary) {
      segment += character;
      continue;
    }
    const trimmed = segment.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    segment = "";
    if ((character === "|" && next === "|") || (character === "&" && next === "&")) {
      index += 1;
    }
  }
  const trimmed = segment.trim();
  if (trimmed.length > 0) segments.push(trimmed);
  return segments;
}

function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += character;
    started = true;
  }
  if (quote !== undefined || escaped) return undefined;
  if (started) words.push(word);
  return words;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function normalizeWord(value: string): string {
  const workspaceRelative = value.startsWith("/workspace/")
    ? value.slice("/workspace/".length)
    : value;
  return workspaceRelative.startsWith("./") ? workspaceRelative.slice(2) : workspaceRelative;
}

function withoutEnvironmentPrefix(words: readonly string[]): string[] {
  let index = 0;
  if (basename(words[index] ?? "") === "env") index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;
  return words.slice(index);
}

function scriptInvocation(words: readonly string[]): StructuredTestInvocation | undefined {
  const executable = normalizeWord(words[0] ?? "");
  const executableName = basename(executable);
  const shell = executableName === "bash" || executableName === "sh";
  const scriptIndex = shell ? 1 : 0;
  const script = normalizeWord(words[scriptIndex] ?? "");
  const scriptName = basename(script);
  if (!/^(?:test|check)(?:[-_.][A-Za-z0-9._-]+)*\.sh$/iu.test(scriptName)) return undefined;
  const normalized = [script, ...words.slice(scriptIndex + 1).map(normalizeWord)];
  return { key: normalized.join("\u001f"), suite: scriptName.slice(0, 256) };
}

function runnerInvocation(words: readonly string[]): StructuredTestInvocation | undefined {
  const normalized = words.map(normalizeWord);
  const executableName = basename(normalized[0] ?? "");
  const argumentsAfterExecutable = normalized.slice(1);
  let recognized = false;
  switch (executableName) {
    case "npm":
    case "pnpm":
    case "yarn":
      recognized = argumentsAfterExecutable.some((word) => /^(?:test|check)(?::.*)?$/iu.test(word));
      break;
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew":
      recognized = argumentsAfterExecutable.some((word) =>
        /^(?:test|check|verify)(?::.*)?$/iu.test(word),
      );
      break;
    case "pytest":
      recognized = true;
      break;
    case "python":
    case "python3":
      recognized = argumentsAfterExecutable[0] === "-m" && argumentsAfterExecutable[1] === "pytest";
      break;
    case "go":
    case "cargo":
    case "dotnet":
      recognized = argumentsAfterExecutable[0] === "test";
      break;
    case "make":
      recognized = argumentsAfterExecutable.some((word) => /^(?:test|check)$/iu.test(word));
      break;
  }
  if (!recognized) return undefined;
  return { key: normalized.join("\u001f"), suite: executableName };
}

function invocationFromWords(words: readonly string[]): StructuredTestInvocation | undefined {
  const executableWords = withoutEnvironmentPrefix(words);
  if (executableWords.length === 0) return undefined;
  return scriptInvocation(executableWords) ?? runnerInvocation(executableWords);
}

export function classifyStructuredTestCommand(
  command: string,
): StructuredTestInvocation | undefined {
  let latest: StructuredTestInvocation | undefined;
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    if (words === undefined) continue;
    latest = invocationFromWords(words) ?? latest;
  }
  return latest;
}
