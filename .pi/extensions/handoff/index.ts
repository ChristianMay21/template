import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const markdownExtensionNames = ["ask", "global", "session", "collection"];

export default async function handoffExtension(pi: ExtensionAPI) {
  const workflowNames = await detectWorkflows();

  // Read all the data out of the workflow files
  const workflowFileData = await Promise.all(workflowNames.map(async workflowName => await readWorkflowSteps(workflowName)))


  // Compile each file to a function that outputs text
  pi.on("session_start", (_event, ctx) => {

  });
}

async function detectWorkflows(): Promise<string[]> {
  const workflowsPath = join(extensionDir, "workflows");

  try {
    const entries = await readdir(workflowsPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readWorkflowSteps(workflowName: string): Promise<(WorkflowFile | WorkflowCollection)[]> {
  const workflowPath = join(extensionDir, "workflows", workflowName);
  return readWorkflowChildren(workflowPath);
}

async function readWorkflowChildren(directoryPath: string): Promise<(WorkflowFile | WorkflowCollection)[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const childSteps = entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".md")))
    .sort((a, b) => a.name.localeCompare(b.name));

  return Promise.all(
    childSteps.map(async (entry): Promise<WorkflowFile | WorkflowCollection> => {
      if (entry.isDirectory()) {
        const childDirectoryPath = join(directoryPath, entry.name);

        return {
          type: "folder",
          name: entry.name,
          children: await readWorkflowChildren(childDirectoryPath),
        };
      }

      return {
        type: "file",
        name: entry.name.slice(0, -".md".length),
        contents: await readFile(join(directoryPath, entry.name), "utf8"),
      };
    }),
  );
}

type WorkflowFile = {
  type: "file"
  name: string
  contents: string
}

type WorkflowCollection = {
  type: "folder"
  name: string
  children: (WorkflowCollection | WorkflowFile)[]
}

function compileWorkflow() {

}

function compileWorkflowFile(file: WorkflowFile) {
  const frontMatterStart = file.contents.indexOf("---");
  const frontMatterContentStart = file.contents.indexOf("\n", frontMatterStart) + 1;
  const frontMatterContentEnd = file.contents.indexOf("---", frontMatterContentStart);

  const frontmatter = frontMatterStart >= 0 && frontMatterContentEnd >= 0
    ? file.contents.slice(frontMatterContentStart, frontMatterContentEnd)
    : "";
  const body = frontMatterContentEnd >= 0
    ? file.contents.slice(file.contents.indexOf("\n", frontMatterContentEnd) + 1)
    : "";
}

function constructPromptFromWorkflowBody(content: string): string {
  const prompt = '';
  const markdownExtensionRegex = constructMarkdownExtensionRegex(markdownExtensionNames);
}

function constructMarkdownExtensionRegex(markdownExtensionNames: string[]): RegExp {
  return new RegExp(`:(${markdownExtensionNames.join("|")})\\{[\\s\\S]*?\\}`, "g");
}

function findFirstRegexMatchRange(text: string, regex: RegExp): { start: number; end: number } | undefined {
  const match = regex.exec(text);
  if (!match) return undefined;

  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function constructExtension(text: string) {
  const nameStart = text.indexOf(":") + 1;
  const nameEnd = text.indexOf("{", nameStart);
  const contentEnd = text.lastIndexOf("}");

  const extensionName = text.slice(nameStart, nameEnd);
  const extensionText = text.slice(nameEnd + 1, contentEnd);

  switch (extensionName) {
    case "ask":
    case "global":
    case "session":
    case "collection":
  }
}

type ParsedAsk = {
  type: "text" | "text-multiline" | "choices" | "confirmation"
  question: string
  options?: string[]
}

function parseAsk(extensionData: string): ParsedAsk {
  const type = readStringField(extensionData, "type") as ParsedAsk["type"];
  const question = readStringField(extensionData, "question");

  if (type === "choices") {
    return {
      type,
      question,
      options: readStringArrayField(extensionData, "options"),
    };
  }

  return { type, question };
}

type ParsedGlobal = {
  file: string
}

function parseGlobal(extensionData: string): ParsedGlobal {
  return { file: readStringField(extensionData, "file") };
}

type ParsedSession = {
  file: string
}

function parseSession(extensionData: string): ParsedSession {
  return { file: readStringField(extensionData, "file") };
}

type ParsedCollection = {
  folder: string
}

function parseCollection(extensionData: string): ParsedCollection {
  return { folder: readStringField(extensionData, "name") };
}

function readStringField(text: string, fieldName: string): string {
  const match = new RegExp(`${fieldName}="([^"]*)"`).exec(text);
  return match?.[1] ?? "";
}

function readStringArrayField(text: string, fieldName: string): string[] {
  const match = new RegExp(`${fieldName}=\\[(.*?)\\]`).exec(text);
  if (!match) return [];

  return [...match[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}