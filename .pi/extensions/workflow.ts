import { spawn } from "node:child_process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODELS = {
	sonnet: "anthropic/claude-sonnet-4-5",
	gpt5: "openai/gpt-5.2",
} as const;

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

// Workflow prompt tokens. Add more keys as your workflows need them, then use
// normal template-literal interpolation in prompts, e.g. `${input.feature}` or `${file.plan}`.
const input = {
	feature: "${input.feature}",
};

const file = {
	plan: "${file.plan}",
};

const run = {
	dir: "${run.dir}",
};

// Edit this object to define your workflows.
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

type SubagentResult = {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
};

let workflowActive = false;

function safeTimestamp(date = new Date()): string {
	return date.toISOString().replace(/:/g, "-");
}

function renderPrompt(
	step: WorkflowStep,
	values: {
		inputs: Record<string, string>;
		files: Record<string, string>;
		runDir: string;
		workflowName: string;
		timestamp: string;
	},
): string {
	let rendered = step.prompt;

	for (const [name, value] of Object.entries(values.inputs)) {
		rendered = rendered.split(`\${input.${name}}`).join(value);
	}
	for (const [name, value] of Object.entries(values.files)) {
		rendered = rendered.split(`\${file.${name}}`).join(value);
	}
	rendered = rendered.split("${run.dir}").join(values.runDir);
	rendered = rendered.split("${workflow.name}").join(values.workflowName);
	rendered = rendered.split("${run.timestamp}").join(values.timestamp);

	const unresolved = rendered.match(/\$\{(?:input|file|run|workflow)\.[^}]+}/);
	if (unresolved) throw new Error(`Unresolved workflow token: ${unresolved[0]}`);

	return rendered;
}

function getFinalOutputFromJsonEvent(line: string): { text?: string; stopReason?: string; errorMessage?: string } | null {
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}

	if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") return null;

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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

async function runSubagent(cwd: string, step: WorkflowStep, prompt: string, signal?: AbortSignal): Promise<SubagentResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--model", step.model];
	if (step.allowedTools.length === 0) {
		args.push("--no-builtin-tools");
	} else {
		args.push("--tools", step.allowedTools.join(","));
	}
	args.push(prompt);

	const invocation = getPiInvocation(args);
	let stdoutBuffer = "";
	let stderr = "";
	let output = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = false;

	const exitCode = await new Promise<number>((resolveExit) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			const parsed = getFinalOutputFromJsonEvent(line);
			if (!parsed) return;
			if (parsed.text !== undefined) output = parsed.text;
			if (parsed.stopReason) stopReason = parsed.stopReason;
			if (parsed.errorMessage) errorMessage = parsed.errorMessage;
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			resolveExit(code ?? 0);
		});

		proc.on("error", () => resolveExit(1));

		if (signal) {
			const abort = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});

	return {
		exitCode: wasAborted ? 1 : exitCode,
		output: output || errorMessage || stderr || "(no output)",
		stderr,
		stopReason,
		errorMessage,
	};
}

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

function preview(text: string, max = 4000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Preview truncated. Full content is in the step log.]`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("workflow", {
		description: "Run a configured multi-step workflow",
		handler: async (args, ctx) => {
			if (workflowActive) {
				ctx.ui.notify("A workflow is already active.", "warning");
				return;
			}

			let workflowName = args.trim();
			if (!workflowName) {
				const names = Object.keys(workflows);
				const choice = await ctx.ui.select(
					"Select workflow",
					names.map((name) => `${name} — ${workflows[name].description}`),
				);
				if (!choice) return;
				workflowName = choice.split(" — ")[0];
			}

			const workflow = workflows[workflowName];
			if (!workflow) {
				ctx.ui.notify(
					`Invalid workflow name: ${workflowName}. Available workflows: ${Object.keys(workflows).join(", ")}`,
					"error",
				);
				return;
			}

			workflowActive = true;
			try {
				const timestamp = safeTimestamp();
				const runDir = resolve(ctx.cwd, "artifacts", workflowName, timestamp);
				await mkdir(runDir, { recursive: true });
				ctx.ui.setStatus("workflow", `${workflowName}: starting`);

				let stepName: string | undefined = workflow.initialStep;
				while (stepName) {
					const step = workflow.steps[stepName];
					if (!step) throw new Error(`Workflow ${workflowName} points to missing step: ${stepName}`);

					ctx.ui.setStatus("workflow", `${workflowName}: ${stepName}`);
					const logPath = join(runDir, `${stepName}.log.md`);
					let attempt = 1;
					let revisionComments = "";
					const inputValues: Record<string, string> = {};
					for (const [inputName, spec] of Object.entries(step.inputs ?? {})) {
						ctx.ui.notify(spec.description, "info");
						const value = await ctx.ui.editor(`${stepName}: ${spec.title}`, "");
						if (spec.required && !value?.trim()) {
							ctx.ui.notify(`Required input omitted: ${spec.title}`, "error");
							return;
						}
						inputValues[inputName] = value ?? "";
					}

					while (true) {
						const fileValues: Record<string, string> = {};
						for (const [fileName, relativePath] of Object.entries(step.inputFiles ?? {})) {
							fileValues[fileName] = await readFile(join(runDir, relativePath), "utf8");
						}

						let prompt = renderPrompt(step, {
							inputs: inputValues,
							files: fileValues,
							runDir,
							workflowName,
							timestamp,
						});

						if (revisionComments.trim()) {
							prompt = `User comments for this attempt:\n\n${revisionComments}\n\nOriginal task:\n\n${prompt}`;
						}

						await appendStepLog(logPath, attempt, { Prompt: prompt }, { startAttempt: true });
						ctx.ui.notify(`Running workflow step: ${stepName} (attempt ${attempt})`, "info");
						const result = await runSubagent(ctx.cwd, step, prompt, ctx.signal);
						await appendStepLog(logPath, attempt, {
							Output: result.output,
							...(result.stderr.trim() ? { Stderr: result.stderr } : {}),
						});

						if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
							const decision = await ctx.ui.select(
								`Step failed: ${stepName}\n\n${preview(result.output)}\n\nLog: ${logPath}`,
								["Retry", "Retry with comments", "Abort workflow"],
							);
							if (decision === "Retry") {
								await appendStepLog(logPath, attempt, { Review: "Retry requested." });
								revisionComments = "";
								attempt++;
								continue;
							}
							if (decision === "Retry with comments") {
								const comments = await ctx.ui.editor(`${stepName}: retry comments`, "Describe what should change for the retry.");
								await appendStepLog(logPath, attempt, { Review: `Retry requested with comments.\n\n${comments ?? ""}` });
								revisionComments = comments ?? "";
								attempt++;
								continue;
							}
							await appendStepLog(logPath, attempt, { Review: "Workflow aborted after step failure." });
							ctx.ui.notify("Workflow aborted.", "warning");
							return;
						}

						const decision = await ctx.ui.select(
							`Review step: ${stepName}\n\n${preview(result.output)}\n\nLog: ${logPath}`,
							["Approve", "Approve with comments", "Revise with comments", "Abort workflow"],
						);

						if (decision === "Approve") {
							await appendStepLog(logPath, attempt, { Review: "Approved without comments." });
							stepName = step.next;
							break;
						}
						if (decision === "Approve with comments") {
							const comments = await ctx.ui.editor(`${stepName}: approval comments`, "Add comments to the audit log.");
							await appendStepLog(logPath, attempt, { Review: `Approved with comments.\n\n${comments ?? ""}` });
							stepName = step.next;
							break;
						}
						if (decision === "Revise with comments") {
							const comments = await ctx.ui.editor(`${stepName}: revision comments`, "Describe the requested revision.");
							await appendStepLog(logPath, attempt, { Review: `Revision requested.\n\n${comments ?? ""}` });
							revisionComments = comments ?? "";
							attempt++;
							continue;
						}

						await appendStepLog(logPath, attempt, { Review: "Workflow aborted during review." });
						ctx.ui.notify("Workflow aborted.", "warning");
						return;
					}
				}

				ctx.ui.notify(`Workflow complete: ${workflowName}\nArtifacts: ${runDir}`, "info");
			} finally {
				workflowActive = false;
				ctx.ui.setStatus("workflow", undefined);
			}
		},
	});

	pi.on("input", (event, ctx) => {
		if (!workflowActive) return;
		if (event.text.trim().startsWith("/workflow")) return;
		ctx.ui.notify("A workflow is active. Complete or abort it before sending normal prompts.", "warning");
		return { action: "handled" as const };
	});
}
