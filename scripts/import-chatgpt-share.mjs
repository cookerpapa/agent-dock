#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const [shareUrl, outputPath] = process.argv.slice(2);
const execFileAsync = promisify(execFile);

if (shareUrl === undefined || outputPath === undefined) {
  console.error("Usage: node scripts/import-chatgpt-share.mjs <share-url> <output.md>");
  process.exit(1);
}

function decodeRouterStream(html) {
  const pattern = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\);/gs;
  const chunks = [];
  for (const match of html.matchAll(pattern)) {
    chunks.push(JSON.parse(match[1]));
  }
  if (chunks.length === 0) {
    throw new Error("The share page did not contain an embedded router stream");
  }
  const firstFrame = chunks.join("").split("\n", 1)[0];
  return JSON.parse(firstFrame);
}

function hydrateFlatData(flat) {
  const cache = new Map();
  const active = new Set();
  const special = new Map([
    [-1, undefined],
    [-2, undefined],
    [-3, Number.NaN],
    [-4, Number.POSITIVE_INFINITY],
    [-5, undefined],
    [-6, undefined],
  ]);

  const dereference = (reference) => {
    if (!Number.isInteger(reference)) return reference;
    if (reference < 0) return special.get(reference);
    return hydrate(reference);
  };

  const hydrate = (index) => {
    if (cache.has(index)) return cache.get(index);
    if (active.has(index)) return undefined;
    active.add(index);
    const encoded = flat[index];
    let value;
    if (Array.isArray(encoded)) {
      value = [];
      cache.set(index, value);
      value.push(...encoded.map(dereference));
    } else if (encoded !== null && typeof encoded === "object") {
      value = {};
      cache.set(index, value);
      for (const [encodedKey, encodedValue] of Object.entries(encoded)) {
        const keyReference = /^_(\d+)$/.exec(encodedKey);
        const key = keyReference === null ? encodedKey : dereference(Number(keyReference[1]));
        value[String(key)] = dereference(encodedValue);
      }
    } else {
      value = encoded;
      cache.set(index, value);
    }
    active.delete(index);
    return value;
  };

  return hydrate(0);
}

function visibleText(content) {
  if (content === null || typeof content !== "object" || !Array.isArray(content.parts)) {
    return "";
  }
  return content.parts
    .filter((part) => typeof part === "string")
    .join("\n")
    .replace(/\uE200[^\uE201]*\uE201/g, "")
    .replaceAll("memcite", "")
    .trim();
}

function renderTranscript({ title, messages, source }) {
  const lines = [
    `# ${title}`,
    "",
    `- Source: ${source}`,
    `- Imported: ${new Date().toISOString()}`,
    `- Visible messages: ${messages.length}`,
    "- Scope: user messages and final assistant answers in the shared conversation; internal reasoning and tool traffic are intentionally excluded.",
    "",
  ];
  for (const [index, message] of messages.entries()) {
    const label = message.role === "user" ? "User" : "Assistant";
    const timestamp = Number.isFinite(message.createTime)
      ? ` · ${new Date(message.createTime * 1000).toISOString()}`
      : "";
    lines.push(`## ${String(index + 1).padStart(3, "0")} · ${label}${timestamp}`);
    lines.push("");
    lines.push(message.text);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function fetchShareHtml(url) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 AgentDock discussion importer" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } catch (fetchError) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        [
          "--fail",
          "--location",
          "--compressed",
          "--max-time",
          "60",
          "--user-agent",
          "Mozilla/5.0",
          url,
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch (curlError) {
      throw new AggregateError([fetchError, curlError], "Failed to fetch ChatGPT share page");
    }
  }
}

const root = hydrateFlatData(decodeRouterStream(await fetchShareHtml(shareUrl)));
const route = root?.loaderData?.["routes/share.$shareId.($action)"];
const conversation = route?.serverResponse?.data;
if (!Array.isArray(conversation?.linear_conversation)) {
  throw new Error("The share page did not contain a linear conversation");
}

const messages = [];
for (const node of conversation.linear_conversation) {
  const message = node?.message;
  const role = message?.author?.role;
  if (role !== "user" && !(role === "assistant" && message.channel === "final")) continue;
  const text = visibleText(message.content);
  if (text.length === 0) continue;
  messages.push({
    role,
    createTime: message.create_time,
    text,
  });
}

if (messages.length === 0) {
  throw new Error("No visible user/assistant messages were extracted");
}

const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(
  destination,
  renderTranscript({
    title: conversation.title ?? "ChatGPT architecture discussion",
    messages,
    source: shareUrl,
  }),
  "utf8",
);
console.log(`Imported ${messages.length} visible messages into ${destination}`);
