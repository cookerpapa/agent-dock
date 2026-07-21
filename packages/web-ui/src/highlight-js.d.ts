declare module "highlight.js/lib/core" {
  type LanguageDefinition = (highlighter?: unknown) => unknown;

  type HighlightResult = {
    value: string;
  };

  const highlighter: {
    registerLanguage(name: string, definition: LanguageDefinition): void;
    highlight(
      code: string,
      options: { language: string; ignoreIllegals?: boolean },
    ): HighlightResult;
  };

  export default highlighter;
}

declare module "highlight.js/lib/languages/*" {
  const language: (highlighter?: unknown) => unknown;
  export default language;
}
