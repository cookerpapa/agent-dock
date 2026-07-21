import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, definition] of Object.entries(languages)) {
  hljs.registerLanguage(name, definition);
}

const EXTENSION_LANGUAGES: Readonly<Record<string, keyof typeof languages>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  csh: "bash",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function sourceLanguage(path: string | null): keyof typeof languages | null {
  if (path === null) return null;
  const normalized = path.toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) return "bash";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) : undefined;
  return extension === undefined ? null : (EXTENSION_LANGUAGES[extension] ?? null);
}

export function highlightSource(
  text: string,
  path: string | null,
): { language: string; html: string } | null {
  const language = sourceLanguage(path);
  if (language === null) return null;
  return {
    language,
    // Highlight.js escapes source text before adding its own span markup.
    html: hljs.highlight(text, { language, ignoreIllegals: true }).value,
  };
}
