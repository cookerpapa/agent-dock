import { AgentDockApiError } from "./api.ts";

export function errorMessage(error: unknown): string {
  if (error instanceof AgentDockApiError) return error.message;
  return "请求没有完成，请稍后重试。";
}
