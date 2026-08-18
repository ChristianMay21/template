import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// -----------------------------------------------------------------------------
// Workflow configuration primitives
// -----------------------------------------------------------------------------
// This extension is intentionally one file. The top section is the part you are
// expected to edit most often: models, prompt tokens, and workflow definitions.

// Keep model names in one small object so workflow steps can refer to readable
// aliases (`MODELS.sonnet`) while the subprocess still receives the provider/model
// string pi expects on the CLI.
const MODELS = {
	sonnet: "anthropic/claude-sonnet-4-5",
	gpt5: "openai/gpt-5.2",
} as const;

// The built-in tools a workflow step is allowed to expose to its subagent.
// Each step must opt into tools explicitly; an empty array means no tools.
type BuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type WorkflowModel = (typeof MODELS)[keyof typeof MODELS];

type StepInput = {
	title: string;
	description: string;
	required: boolean;
};

type WorkflowStep = {
	description: string;
	model: WorkflowModel;
	allowedTools: BuiltInToolName[];
	inputs?: Record<string, StepInput>;
	inputFiles?: Record<string, string>;
	prompt: string;
	next?: string;
};

type Workflow = {
	description: string;
	initialStep: string;
	steps: Record<string, WorkflowStep>;
};

// -----------------------------------------------------------------------------
// Prompt token helpers
// -----------------------------------------------------------------------------
// These constants are intentionally just strings. They make workflow prompts read
// like ordinary TypeScript template strings:
//
//   prompt: `Use this plan: ${file.plan}`
//
// At extension-load time, `${file.plan}` becomes the literal text
// `${file.plan}`. Later, immediately before the step runs, renderPrompt()
// replaces that literal token with the runtime file contents.
//
// If you add a workflow input called `requirements`, add:
//   requirements: "${input.requirements}"
// to `input`, then use `${input.requirements}` in prompts.
const input = {
	feature: "${input.feature}",
};

// If you add an input file called `requirements`, add:
//   requirements: "${file.requirements}"
// to `file`, then use `${file.requirements}` in prompts.
const file = {
	plan: "${file.plan}",
};

// Runtime metadata tokens. `run.dir` is the most important one: it points to the
// artifact folder for the current workflow run.
const run = {
	dir: "${run.dir}",
};

// -----------------------------------------------------------------------------
// Workflow definitions
// -----------------------------------------------------------------------------
// Edit this object to define your workflows. A workflow names its first step with
// `initialStep`; each step can name a `next` step. If `next` is omitted, the
// workflow is complete after that step is approved.
//
// `inputFiles` paths are relative to the current run artifact folder:
//   <project-root>/artifacts/<workflow-name>/<timestamp>/
// Their contents are injected into prompt tokens like `${file.plan}`.
const workflows: Record<string, Workflow> = {
	"sample-workflow": {
		description: "A small editable sample workflow. Replace this with your real workflow definitions.",
		initialStep: "plan",
		steps: {
			plan: {
				description: "Create a short plan from user input and save it as an artifact.",
				model: MODELS.sonnet,
				allowedTools: ["write"],
				inputs: {
					feature: {
						title: "Feature description",
						description: "Describe the feature, change, or task for this workflow run.",
						required: true,
					},
				},
				prompt: `Create a concise implementation plan for this request:

${input.feature}

Write the plan to this markdown file:

${run.dir}/plan.md`,
				next: "implement",
			},

			implement: {
				description: "Implement or report on the approved plan.",
				model: MODELS.sonnet,
				allowedTools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
				inputFiles: {
					plan: "plan.md",
				},
				prompt: `Use this approved plan:

${file.plan}

Implement the plan. Write any notes or follow-up context to files in this artifact folder:

${run.dir}`,
			},
		},
	},
};

// -----------------------------------------------------------------------------
// Runtime data shapes
// -----------------------------------------------------------------------------

type RunInfo = {
	workflowName: string;
	timestamp: string;
	runDir: string;
};

type SubagentResult = {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
};

type StepDecision = "approved" | "revised" | "aborted";
type FailureDecision = "retry" | "retry-with-comments" | "aborted";

// Used to prevent overlapping workflow runs in this pi process.
let workflowActive = false;

// -----------------------------------------------------------------------------
// Small general helpers
// -----------------------------------------------------------------------------

// Filesystem-safe timestamp for artifact folder names. ISO is nice for sorting,
// but raw ISO contains ':' which is awkward on Windows, so replace ':' with '-'.
function safeTimestamp(date = new Date()): string {
	return date.toISOString().replace(/:/g, "-");
}

function buildRunInfo(cwd: string, workflowName: string): RunInfo {
	const timestamp = safeTimestamp();
	const runDir = resolve(cwd, "artifacts", workflowName, timestamp);
	return { workflowName, timestamp, runDir };
}

// Keep review dialogs readable. Full output always remains in the step log.
function preview(text: string, max = 4000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Preview truncated. Full content is in the step log.]`;
}

function appendUserCommentsToPrompt(prompt: string, comments: string): string {
	if (!comments.trim()) return prompt;

	return `User comments for this attempt:\n\n${comments}\n\nOriginal task:\n\n${prompt}`;
}

function subagentFailed(result: SubagentResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

// -----------------------------------------------------------------------------
// Prompt rendering
// -----------------------------------------------------------------------------

function replaceNamedTokens(prefix: "input" | "file", rendered: string, values: Record<string, string>): string {
	let next = rendered;

	for (const [name, value] of Object.entries(values)) {
		// Build the literal token text we expect inside the prompt, e.g.
		// `${input.feature}` or `${file.plan}`.
		const token = "${" + prefix + "." + name + "}";
		next = next.split(token).join(value);
	}

	return next;
}

function replaceRunTokens(rendered: string, runInfo: RunInfo): string {
	return rendered
		.split("${run.dir}").join(runInfo.runDir)
		.split("${workflow.name}").join(runInfo.workflowName)
		.split("${run.timestamp}").join(runInfo.timestamp);
}

function throwIfPromptHasUnresolvedToken(rendered: string): void {
	const unresolved = rendered.match(/\$\{(?:input|file|run|workflow)\.[^}]+}/);
	if (!unresolved) return;

	throw new Error(`Unresolved workflow token: ${unresolved[0]}`);
}

// Render the prompt for a single step attempt.
//
// At definition time, prompts contain literal tokens such as `${input.feature}`
// and `${file.plan}`. At runtime this function swaps those tokens for collected
// user input, loaded artifact file contents, and run metadata.
function renderPrompt(
	step: WorkflowStep,
	values: {
		inputs: Record<string, string>;
		files: Record<string, string>;
		runInfo: RunInfo;
	},
): string {
	let rendered = step.prompt;

	rendered = replaceNamedTokens("input", rendered, values.inputs);
	rendered = replaceNamedTokens("file", rendered, values.files);
	rendered = replaceRunTokens(rendered, values.runInfo);

	throwIfPromptHasUnresolvedToken(rendered);

	return rendered;
}

// -----------------------------------------------------------------------------
// Step log helpers
// -----------------------------------------------------------------------------

// Append markdown sections to a step's single log file. Each attempt starts with
// a top-level heading, then Prompt/Output/Review/Stderr sections are appended as
// the attempt progresses.
async function appendStepLog(
	path: string,
	attempt: number,
	sections: Record<string, string>,
	options: { startAttempt?: boolean } = {},
): Promise<void> {
	let text = options.startAttempt ? `\n\n# Attempt ${attempt}\n` : "";

	for (const [title, content] of Object.entries(sections)) {
		text += `\n## ${title}\n\n${content.trim() || "(empty)"}\n`;
	}

	await appendFile(path, text, "utf8");
}

// -----------------------------------------------------------------------------
// Subagent process mechanics
// -----------------------------------------------------------------------------
// A "subagent" here is not a special hidden pi object. It is another pi process
// that this extension starts in the background.
//
// Important terminal/process concepts used below:
// - A process can receive command-line arguments, e.g. `pi --mode json -p ...`.
// - stdout is the child process's normal output stream.
// - stderr is the child process's error/log output stream.
// - pi's JSON mode writes one JSON object per stdout line, so we parse stdout
//   line-by-line and look for the final assistant message.

function buildSubagentArgs(step: WorkflowStep, prompt: string): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--model", step.model];

	if (step.allowedTools.length === 0) {
		args.push("--no-builtin-tools");
	} else {
		args.push("--tools", step.allowedTools.join(","));
	}

	args.push(prompt);
	return args;
}

// Prefer invoking the same pi executable/script that loaded this extension. This
// avoids assuming `pi` is on PATH when the current process already knows how it
// was launched.
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];

	if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	return { command: "pi", args };
}

// pi JSON mode prints newline-delimited JSON events. We only need the final
// assistant message for this workflow: that is the subagent's reviewable output.
function extractAssistantOutputFromJsonLine(
	line: string,
): { text?: string; stopReason?: string; errorMessage?: string } | null {
	let event: any;

	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}

	if (event.type !== "message_end") return null;
	if (!event.message || event.message.role !== "assistant") return null;

	let text = "";
	for (const part of event.message.content ?? []) {
		if (part.type === "text") text += part.text;
	}

	return {
		text,
		stopReason: event.message.stopReason,
		errorMessage: event.message.errorMessage,
	};
}

function processSubagentStdoutChunk(
	chunk: string,
	buffer: string,
	onAssistantOutput: (parsed: { text?: string; stopReason?: string; errorMessage?: string }) => void,
): string {
	const combined = buffer + chunk;
	const lines = combined.split("\n");
	const remainingPartialLine = lines.pop() ?? "";

	for (const line of lines) {
		const parsed = extractAssistantOutputFromJsonLine(line);
		if (parsed) onAssistantOutput(parsed);
	}

	return remainingPartialLine;
}

function applyAssistantOutput(
	parsed: { text?: string; stopReason?: string; errorMessage?: string },
	state: { output: string; stopReason?: string; errorMessage?: string },
): void {
	if (parsed.text !== undefined) state.output = parsed.text;
	if (parsed.stopReason) state.stopReason = parsed.stopReason;
	if (parsed.errorMessage) state.errorMessage = parsed.errorMessage;
}

function attachAbortHandler(proc: ReturnType<typeof spawn>, signal: AbortSignal | undefined, markAborted: () => void): void {
	if (!signal) return;

	const abort = () => {
		markAborted();

		// SIGTERM asks the child process to exit gracefully. If it does not, SIGKILL
		// is sent later as a last resort.
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, 5000);
	};

	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
}

// Run one workflow step attempt as an isolated pi subprocess.
async function runSubagent(cwd: string, step: WorkflowStep, prompt: string, signal?: AbortSignal): Promise<SubagentResult> {
	const invocation = getPiInvocation(buildSubagentArgs(step, prompt));

	const assistantState = {
		output: "",
		stopReason: undefined as string | undefined,
		errorMessage: undefined as string | undefined,
	};

	let stdoutBuffer = "";
	let stderr = "";
	let wasAborted = false;

	const exitCode = await new Promise<number>((resolveExit) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		proc.stdout.on("data", (data) => {
			stdoutBuffer = processSubagentStdoutChunk(data.toString(), stdoutBuffer, (parsed) => {
				applyAssistantOutput(parsed, assistantState);
			});
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			const parsed = extractAssistantOutputFromJsonLine(stdoutBuffer);
			if (parsed) applyAssistantOutput(parsed, assistantState);
			resolveExit(code ?? 0);
		});

		proc.on("error", () => resolveExit(1));

		attachAbortHandler(proc, signal, () => {
			wasAborted = true;
		});
	});

	return {
		exitCode: wasAborted ? 1 : exitCode,
		output: assistantState.output || assistantState.errorMessage || stderr || "(no output)",
		stderr,
		stopReason: assistantState.stopReason,
		errorMessage: assistantState.errorMessage,
	};
}

// -----------------------------------------------------------------------------
// Workflow step preparation
// -----------------------------------------------------------------------------

async function collectStepInputs(stepName: string, step: WorkflowStep, ctx: any): Promise<Record<string, string> | null> {
	const values: Record<string, string> = {};

	for (const [inputName, spec] of Object.entries(step.inputs ?? {})) {
		ctx.ui.notify(spec.description, "info");

		const value = await ctx.ui.editor(`${stepName}: ${spec.title}`, "");
		if (spec.required && !value?.trim()) {
			ctx.ui.notify(`Required input omitted: ${spec.title}`, "error");
			return null;
		}

		values[inputName] = value ?? "";
	}

	return values;
}

async function loadStepInputFiles(step: WorkflowStep, runInfo: RunInfo): Promise<Record<string, string>> {
	const values: Record<string, string> = {};

	for (const [fileName, relativePath] of Object.entries(step.inputFiles ?? {})) {
		const absolutePath = join(runInfo.runDir, relativePath);
		values[fileName] = await readFile(absolutePath, "utf8");
	}

	return values;
}

async function buildAttemptPrompt(args: {
	step: WorkflowStep;
	inputs: Record<string, string>;
	runInfo: RunInfo;
	revisionComments: string;
}): Promise<string> {
	const files = await loadStepInputFiles(args.step, args.runInfo);

	const basePrompt = renderPrompt(args.step, {
		inputs: args.inputs,
		files,
		runInfo: args.runInfo,
	});

	return appendUserCommentsToPrompt(basePrompt, args.revisionComments);
}

// -----------------------------------------------------------------------------
// Review dialogs
// -----------------------------------------------------------------------------

async function askAfterFailedStep(stepName: string, output: string, logPath: string, ctx: any): Promise<FailureDecision> {
	const decision = await ctx.ui.select(
		`Step failed: ${stepName}\n\n${preview(output)}\n\nLog: ${logPath}`,
		["Retry", "Retry with comments", "Abort workflow"],
	);

	if (decision === "Retry") return "retry";
	if (decision === "Retry with comments") return "retry-with-comments";
	return "aborted";
}

// -----------------------------------------------------------------------------
// Attempt and step execution
// -----------------------------------------------------------------------------

async function runOneAttempt(args: {
	cwd: string;
	step: WorkflowStep;
	inputs: Record<string, string>;
	runInfo: RunInfo;
	logPath: string;
	attempt: number;
	revisionComments: string;
	signal?: AbortSignal;
	ctx: any;
}): Promise<SubagentResult> {
	const prompt = await buildAttemptPrompt({
		step: args.step,
		inputs: args.inputs,
		runInfo: args.runInfo,
		revisionComments: args.revisionComments,
	});

	await appendStepLog(args.logPath, args.attempt, { Prompt: prompt }, { startAttempt: true });

	args.ctx.ui.notify(`Running workflow step attempt ${args.attempt}`, "info");
	const result = await runSubagent(args.cwd, args.step, prompt, args.signal);

	await appendStepLog(args.logPath, args.attempt, {
		Output: result.output,
		...(result.stderr.trim() ? { Stderr: result.stderr } : {}),
	});

	return result;
}

async function handleFailedAttempt(args: {
	stepName: string;
	result: SubagentResult;
	logPath: string;
	attempt: number;
	ctx: any;
}): Promise<{ continueStep: boolean; revisionComments: string; aborted: boolean }> {
	const decision = await askAfterFailedStep(args.stepName, args.result.output, args.logPath, args.ctx);

	if (decision === "retry") {
		await appendStepLog(args.logPath, args.attempt, { Review: "Retry requested." });
		return { continueStep: true, revisionComments: "", aborted: false };
	}

	if (decision === "retry-with-comments") {
		const comments = await args.ctx.ui.editor(`${args.stepName}: retry comments`, "");
		await appendStepLog(args.logPath, args.attempt, { Review: `Retry requested with comments.\n\n${comments ?? ""}` });
		return { continueStep: true, revisionComments: comments ?? "", aborted: false };
	}

	await appendStepLog(args.logPath, args.attempt, { Review: "Workflow aborted after step failure." });
	args.ctx.ui.notify("Workflow aborted.", "warning");
	return { continueStep: false, revisionComments: "", aborted: true };
}

async function handleSuccessfulAttempt(args: {
	stepName: string;
	result: SubagentResult;
	logPath: string;
	attempt: number;
	ctx: any;
}): Promise<{ decision: StepDecision; revisionComments: string }> {
	const rawDecision = await args.ctx.ui.select(
		`Review step: ${args.stepName}\n\n${preview(args.result.output)}\n\nLog: ${args.logPath}`,
		["Approve", "Approve with comments", "Revise with comments", "Abort workflow"],
	);

	if (rawDecision === "Approve") {
		await appendStepLog(args.logPath, args.attempt, { Review: "Approved without comments." });
		return { decision: "approved", revisionComments: "" };
	}

	if (rawDecision === "Approve with comments") {
		const comments = await args.ctx.ui.editor(`${args.stepName}: approval comments`, "");
		await appendStepLog(args.logPath, args.attempt, { Review: `Approved with comments.\n\n${comments ?? ""}` });
		return { decision: "approved", revisionComments: "" };
	}

	if (rawDecision === "Revise with comments") {
		const comments = await args.ctx.ui.editor(`${args.stepName}: revision comments`, "");
		await appendStepLog(args.logPath, args.attempt, { Review: `Revision requested.\n\n${comments ?? ""}` });
		return { decision: "revised", revisionComments: comments ?? "" };
	}

	await appendStepLog(args.logPath, args.attempt, { Review: "Workflow aborted during review." });
	args.ctx.ui.notify("Workflow aborted.", "warning");
	return { decision: "aborted", revisionComments: "" };
}

async function runWorkflowStep(args: {
	cwd: string;
	workflowName: string;
	stepName: string;
	step: WorkflowStep;
	runInfo: RunInfo;
	ctx: any;
}): Promise<{ nextStep?: string; aborted: boolean }> {
	const logPath = join(args.runInfo.runDir, `${args.stepName}.log.md`);

	const inputs = await collectStepInputs(args.stepName, args.step, args.ctx);
	if (!inputs) return { aborted: true };

	let attempt = 1;
	let revisionComments = "";

	while (true) {
		const result = await runOneAttempt({
			cwd: args.cwd,
			step: args.step,
			inputs,
			runInfo: args.runInfo,
			logPath,
			attempt,
			revisionComments,
			signal: args.ctx.signal,
			ctx: args.ctx,
		});

		if (subagentFailed(result)) {
			const failure = await handleFailedAttempt({
				stepName: args.stepName,
				result,
				logPath,
				attempt,
				ctx: args.ctx,
			});

			if (failure.aborted) return { aborted: true };

			revisionComments = failure.revisionComments;
			attempt++;
			continue;
		}

		const success = await handleSuccessfulAttempt({
			stepName: args.stepName,
			result,
			logPath,
			attempt,
			ctx: args.ctx,
		});

		if (success.decision === "approved") return { nextStep: args.step.next, aborted: false };
		if (success.decision === "aborted") return { aborted: true };

		revisionComments = success.revisionComments;
		attempt++;
	}
}

// -----------------------------------------------------------------------------
// Workflow command helpers
// -----------------------------------------------------------------------------

async function chooseWorkflowName(args: string, ctx: any): Promise<string | null> {
	const requestedName = args.trim();
	if (requestedName) return requestedName;

	const names = Object.keys(workflows);
	const choice = await ctx.ui.select(
		"Select workflow",
		names.map((name) => `${name} — ${workflows[name].description}`),
	);

	if (!choice) return null;
	return choice.split(" — ")[0];
}

function getWorkflowOrNotify(name: string, ctx: any): Workflow | null {
	const workflow = workflows[name];
	if (workflow) return workflow;

	ctx.ui.notify(`Invalid workflow name: ${name}. Available workflows: ${Object.keys(workflows).join(", ")}`, "error");
	return null;
}

async function runWorkflow(workflowName: string, workflow: Workflow, ctx: any): Promise<void> {
	const runInfo = buildRunInfo(ctx.cwd, workflowName);

	await mkdir(runInfo.runDir, { recursive: true });
	ctx.ui.setStatus("workflow", `${workflowName}: starting`);

	let stepName: string | undefined = workflow.initialStep;

	while (stepName) {
		const step = workflow.steps[stepName];
		if (!step) throw new Error(`Workflow ${workflowName} points to missing step: ${stepName}`);

		ctx.ui.setStatus("workflow", `${workflowName}: ${stepName}`);

		const result = await runWorkflowStep({
			cwd: ctx.cwd,
			workflowName,
			stepName,
			step,
			runInfo,
			ctx,
		});

		if (result.aborted) return;
		stepName = result.nextStep;
	}

	ctx.ui.notify(`Workflow complete: ${workflowName}\nArtifacts: ${runInfo.runDir}`, "info");
}

// -----------------------------------------------------------------------------
// Extension entry point
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// /workflow is the main user entrypoint. With no args it opens a workflow
	// selector; with an arg it starts that named workflow immediately.
	pi.registerCommand("workflow", {
		description: "Run a configured multi-step workflow",
		handler: async (args, ctx) => {
			if (workflowActive) {
				ctx.ui.notify("A workflow is already active.", "warning");
				return;
			}

			const workflowName = await chooseWorkflowName(args, ctx);
			if (!workflowName) return;

			const workflow = getWorkflowOrNotify(workflowName, ctx);
			if (!workflow) return;

			workflowActive = true;

			try {
				await runWorkflow(workflowName, workflow, ctx);
			} finally {
				workflowActive = false;
				ctx.ui.setStatus("workflow", undefined);
			}
		},
	});

	// Defensive guard: while a workflow is active, regular prompts are treated as
	// out-of-band and blocked so they do not interfere with the orchestrated flow.
	pi.on("input", (event, ctx) => {
		if (!workflowActive) return;
		if (event.text.trim().startsWith("/workflow")) return;

		ctx.ui.notify("A workflow is active. Complete or abort it before sending normal prompts.", "warning");
		return { action: "handled" as const };
	});
}
