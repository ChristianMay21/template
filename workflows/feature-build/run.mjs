#!/usr/bin/env node
/**
 * run.mjs — step → agent → human review → gate loop.
 *
 * Usage:
 *   node workflow/run.mjs                # agent = pi -p
 *   node workflow/run.mjs -- claude -p   # any CLI that reads a prompt on stdin
 *
 * Every .md file in ./steps is a prompt template, run in filename order.
 * For each step:
 *   1. Scan the template for {{PLACEHOLDER}} tokens and ask you for values.
 *      Each value is asked once, then reused across later steps.
 *   2. Print the fully rendered prompt, then pipe it to a fresh agent
 *      process — the agent's context is exactly what you see, nothing more.
 *   3. Review the result:  [p]ass → next step
 *                          [r]edo → re-run this step, your notes fill {{FEEDBACK}}
 *                          [q]uit → stop the workflow
 *
 * {{FEEDBACK}} is reserved: never asked for, filled automatically with your
 * redo notes (empty on a step's first attempt).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";

// ------------------------------------------------------------------ config

// Templates live in ./steps next to this file, wherever the folder is.
const STEPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "steps");

// Matches {{NAME}} — upper-case letters, digits, underscores.
// Capture group 1 is the placeholder name.
const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

// Everything after "--" on the command line is the agent command.
// Default: pi in print mode, which merges piped stdin into its prompt.
const separator = argv.indexOf("--");
const agentCommand =
  separator === -1 ? ["pi", "-p"] : argv.slice(separator + 1);

// One readline interface for all interactive questions.
const io = createInterface({ input: stdin, output: stdout });

// Placeholder values, keyed by name. Filled lazily the first time a name
// appears in any template, then reused — so {{FEATURE}} in three steps
// is asked exactly once.
const values = {};

// -------------------------------------------------------------- functions

/**
 * Fill a template's placeholders and return the finished prompt.
 * Asks the user for any placeholder we haven't seen before.
 * `feedback` is the reviewer's note from the previous attempt ("" on first).
 */
async function renderTemplate(template, feedback) {
  values.FEEDBACK = feedback; // reserved: set by the loop, never asked

  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!(name in values)) {
      values[name] = await io.question(`  ${name}: `);
    }
  }

  return template.replace(PLACEHOLDER, (_, name) => values[name] ?? "");
}

/**
 * Run one agent attempt with the given prompt.
 * A fresh process is spawned per attempt, so nothing carries over between
 * attempts or steps except the repo itself.
 * Resolves with the agent's exit code and never rejects — the human is
 * the judge of success here, not the exit code.
 */
function runAgent(prompt) {
  return new Promise((resolve) => {
    const child = spawn(agentCommand[0], agentCommand.slice(1), {
      // stdin: we pipe the prompt in.
      // stdout/stderr: stream live to your terminal so you can watch it work.
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", (err) => {
      // e.g. the agent binary isn't installed / not on PATH
      console.error(`could not start agent: ${err.message}`);
      resolve(1);
    });

    // A null code means the process was killed by a signal; treat as failure.
    child.on("close", (code) => resolve(code ?? 1));

    child.stdin.end(prompt); // write the whole prompt, then close stdin
  });
}

/** Ask for the review verdict, re-asking until the answer is p, r, or q. */
async function askVerdict(stepName) {
  while (true) {
    const answer = (
      await io.question(`\n${stepName}: [p]ass / [r]edo / [q]uit > `)
    )
      .trim()
      .toLowerCase();
    if (answer === "p" || answer === "r" || answer === "q") return answer;
  }
}

/**
 * Run one step to completion: attempt → review → (redo …) until passed.
 * Returns true to continue the workflow, false if the user quit.
 */
async function runStep(stepFile) {
  const template = await readFile(join(STEPS_DIR, stepFile), "utf8");
  let feedback = "";

  for (let attempt = 1; ; attempt++) {
    console.log(`\n━━━ ${stepFile} · attempt ${attempt} ━━━`);

    const prompt = await renderTemplate(template, feedback);
    console.log(`\n${prompt}\n───`); // show exactly what the agent receives

    const exitCode = await runAgent(prompt);
    if (exitCode !== 0) console.warn(`(agent exited with code ${exitCode})`);

    const verdict = await askVerdict(stepFile);
    if (verdict === "p") return true; // passed → next step
    if (verdict === "q") return false; // quit → stop workflow

    feedback = await io.question("  feedback: "); // redo, with notes
  }
}

// ------------------------------------------------------------------- main

const stepFiles = (await readdir(STEPS_DIR))
  .filter((file) => file.endsWith(".md"))
  .sort(); // filename order defines step order: 01-…, 02-…, 03-…

if (stepFiles.length === 0) {
  console.error(`no .md templates found in ${STEPS_DIR}`);
  exit(1);
}

for (const stepFile of stepFiles) {
  const passed = await runStep(stepFile);
  if (!passed) {
    io.close();
    exit(0); // user quit mid-workflow
  }
}

console.log("\n✓ all steps passed");
io.close();
