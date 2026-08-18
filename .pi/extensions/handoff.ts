import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import inquirer from "inquirer";

type MessagePart = { type: string; text?: string };

async function plan(pi: ExtensionAPI, input: string, sessionID: string) {
	const answer = await inquirer.prompt<{ response: string }>([
		{
			type: "input",
			name: "response",
			message: "What do you want to do?",
		},
	]);
  const response: string = answer.response;
  if (!sessionID) {
    sessionID = Date.now().toString();
  }
  const prompt = `The user would like to accomplish the following: ${response}.

    Interview the user relentlessly until you reach a shared understanding. Map this as a *design tree*: every decision branches into the decisions that hang off it.

    Work the tree in *rounds*. The *frontier* is every decision whosse prerequisites are already settled -- the questions you can ask *now* without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question.
    Then wait for the user's answers before the next round.

    Each question should be formatted like so:
    \`\`\`
    ❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>
    \`\`\`

    Each round the user answers reshapes the tree - settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

    Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

    The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

    Once you believe you have reached a shared understanding wit hthe user, include exactly <<<HANDOFF_PLAN_READY ${sessionID}>>> in your response.
    `;
	pi.sendUserMessage(prompt);
}

function prd(pi: ExtensionAPI, sessionID: string) {
  const prompt = `
    You are to take the current conversation context and your codebase understanding and produce a spec. Do NOT interview the user - just synthesize what you already know.

    1. Explore the repo to understand the current state of the codebase, if you haven't already.
    2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

    Check with the user that these seams match their expections.

    3. Write the spec using the template below, then save it to ~/.handoff/${sessionID}/prd.md, where ~ is the project root.

    <spec-template>
    ### US-001: [Title]
    **Description:** As a [user], I want [feature] so that [benefit].

    **Acceptance Criteria:**
    - [ ] Specific verifiable criterion
    - [ ] Another criterion
    - [ ] Typecheck/lint passes

    *Important:**
    - Acceptance criteria must be verifiable, not vague. "Works correctly" is bad. "Button shows confirmation dialog before deleting" is good.

    ### 4. Functional Requirements
    Numbered list of specific functionalities:
    - "FR-1: The system must allow users to..."
    - "FR-2: When a user clicks X, the system must..."

    Be explicit and unambiguous.

    ### 5. Non-Goals (Out of Scope)
    What this feature will NOT include. Critical for managing scope.

    ### 6. Design Considerations (Optional)
    - UI/UX requirements
    - Link to mockups if available
    - Relevant existing components to reuse

    ### 7. Technical Considerations (Optional)
    - Known constraints or dependencies
    - Integration points with existing systems
    - Performance requirements

    ### 8. Success Metrics
    How will success be measured?
    - "Reduce time to complete X by 50%"
    - "Increase conversion rate by 10%"

    ### 9. Open Questions
    Remaining questions or areas needing clarification.

    <spec-template>

    ---

    ## Writing for Junior Developers

    The PRD reader may be a junior developer or AI agent. Therefore:

    - Be explicit and unambiguous
    - Avoid jargon or explain it
    - Provide enough detail to understand purpose and core logic
    - Number requirements for easy reference
    - Use concrete examples where helpful

    ---

    ## Example PRD
    <spec-template>
    # PRD: Task Priority System

    ## Introduction

    Add priority levels to tasks so users can focus on what matters most. Tasks can be marked as high, medium, or low priority, with visual indicators and filtering to help users manage their workload effectively.

    ## Goals

    - Allow assigning priority (high/medium/low) to any task
    - Provide clear visual differentiation between priority levels
    - Enable filtering and sorting by priority
    - Default new tasks to medium priority

    ## User Stories

    ### US-001: Add priority field to database
    **Description:** As a developer, I need to store task priority so it persists across sessions.

    **Acceptance Criteria:**
    - [ ] Add priority column to tasks table: 'high' | 'medium' | 'low' (default 'medium')
    - [ ] Generate and run migration successfully
    - [ ] Typecheck passes

    ### US-002: Display priority indicator on task cards
    **Description:** As a user, I want to see task priority at a glance so I know what needs attention first.

    **Acceptance Criteria:**
    - [ ] Each task card shows colored priority badge (red=high, yellow=medium, gray=low)
    - [ ] Priority visible without hovering or clicking
    - [ ] Typecheck passes
    - [ ] Verify in browser using dev-browser skill

    ### US-003: Add priority selector to task edit
    **Description:** As a user, I want to change a task's priority when editing it.

    **Acceptance Criteria:**
    - [ ] Priority dropdown in task edit modal
    - [ ] Shows current priority as selected
    - [ ] Saves immediately on selection change
    - [ ] Typecheck passes
    - [ ] Verify in browser using dev-browser skill

    ### US-004: Filter tasks by priority
    **Description:** As a user, I want to filter the task list to see only high-priority items when I'm focused.

    **Acceptance Criteria:**
    - [ ] Filter dropdown with options: All | High | Medium | Low
    - [ ] Filter persists in URL params
    - [ ] Empty state message when no tasks match filter
    - [ ] Typecheck passes
    - [ ] Verify in browser using dev-browser skill

    ## Functional Requirements

    - FR-1: Add \`priority\` field to tasks table ('high' | 'medium' | 'low', default 'medium')
    - FR-2: Display colored priority badge on each task card
    - FR-3: Include priority selector in task edit modal
    - FR-4: Add priority filter dropdown to task list header
    - FR-5: Sort by priority within each status column (high to medium to low)

    ## Non-Goals

    - No priority-based notifications or reminders
    - No automatic priority assignment based on due date
    - No priority inheritance for subtasks

    ## Technical Considerations

    - Reuse existing badge component with color variants
    - Filter state managed via URL search params
    - Priority stored in database, not computed

    ## Success Metrics

    - Users can change priority in under 2 clicks
    - High-priority tasks immediately visible at top of lists
    - No regression in task list performance

    </spec-template>
    `;
	pi.sendUserMessage(prompt);
}

function build(pi: ExtensionAPI, input: string) {
	const prompt = "";
	pi.sendUserMessage(prompt);
}

function review(pi: ExtensionAPI, input: string) {
	const prompt = "";
	pi.sendUserMessage(prompt);
}

// Pi extensions are loaded through their default export; the documented examples use an anonymous default factory.
// eslint-disable-next-line import/no-anonymous-default-export
export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event: MessageEndEvent) => {
		if (event.message.role !== "assistant") return;

		const text = event.message.content
			.map((part: MessagePart) => part.type === "text" ? part.text ?? "" : "")
			.join("");

		const markerStart = "<<<HANDOFF_PLAN_READY ";
		const markerEnd = ">>>";
		const markerStartIndex = text.indexOf(markerStart);

		if (markerStartIndex !== -1) {
			const sessionIDStart = markerStartIndex + markerStart.length;
			const sessionIDEnd = text.indexOf(markerEnd, sessionIDStart);
			if (sessionIDEnd === -1) return;

			const sessionID = text.slice(sessionIDStart, sessionIDEnd).trim();
			const answer = await inquirer.prompt<{ complete: "yes" | "no" }>([
				{
					type: "list",
					name: "complete",
					message: "Planning complete?",
					choices: ["yes", "no"],
				},
			]);

      if (answer.complete === "no") {
        const issue = await inquirer.prompt<{ text: string }>([
          {
            type: "input",
            name: "text",
            message: "What is the issue?",
          },
        ]);

        if (issue.text.trim()) {
          pi.sendUserMessage(issue.text, { deliverAs: "followUp" });
        }
      } else {
        prd(pi, sessionID);
      }
		}
	});
}
