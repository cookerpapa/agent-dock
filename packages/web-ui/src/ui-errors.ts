import { PiCloudApiError } from "./api.ts";

export function errorMessage(error: unknown): string {
  if (error instanceof PiCloudApiError) return error.message;
  return "请求没有完成，请稍后重试。";
}
