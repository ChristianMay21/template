import { readFile, readdir } from 'node:fs/promises'

export type HandoffConfig = {
  workflows: Record<string, Workflow>
}

// Files that stay the same across every run of the extension
export enum StaticFile {
  Plan,
  CreatePRD,
  CreateTickets,
  FrontendDesign,
  Implement,
  Review
}

// Single files that are created during the workflow
export enum SessionFile {
  PRD
}

// Folders for each session that will have 1-to-many files within it per session
export enum SessionCollection {
  Tickets
}

type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type TerminationCondition = "manual" | "automatic";
const MODELS = {
   sonnet: "anthropic/claude-sonnet-4-5",
   gpt5: "openai/gpt-5.2",
} as const;

type Workflow = {
  description: string,
  workstages: Workstage[]
}

type Workstage = {
  inputs: 
  prompt: string | (() => string),
  allowedTools: ToolName[],
  model: string,
  terminationCondition: TerminationCondition
  clearContext: boolean
}

type UserInput = UserTextInput | UserChoiceInput | UserConfirmationInput;

type UserTextInput = {
  name: string
  type: "text"
  lines: "single" | "multi"
  userPrompt: string
}

type UserChoiceInput = {
  name: string
  type: "choice"
  choices: string[]
  userPrompt: string
}

type UserConfirmationInput = {
  name: string
  type: "confirmation"
  userPrompt: string
}

async function readStaticFile(file: StaticFile): Promise<string> {
  const fileContents = await readFile(new URL(`./files/${StaticFile[file]}.md`, import.meta.url), 'utf8')
  return fileContents;
}

async function readSessionFile(file: SessionFile, sessionID: string): Promise<string> {
  const fileContents = await readFile(new URL(`./sessions/${sessionID}/files/${SessionFile[file]}.md`, import.meta.url), 'utf8')
  return fileContents;
}

async function readSessionCollection(collection: SessionCollection, sessionID: string): Promise<string[]> {
  const dir = new URL(`./sessions/${sessionID}/collections/${SessionCollection[collection]}/`, import.meta.url);
  const entries = await readdir(dir);
  const files = entries.filter(e => e.endsWith('.md')).sort();
  return Promise.all(files.map(f => readFile(new URL(f, dir), 'utf8')));
}

function setup() {
  // Check that static files exist

  // Check that models in models object are available


}
