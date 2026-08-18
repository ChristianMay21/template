import type { HandoffConfig } from "./index-old.ts"
import {readSessionFile, readStaticFile, read}


export const config: HandoffConfig = {
  workflows: {
    main: {
      description: "Make a change to the repo",
      workstages: {
        plan: {
          prompt: "Plan the feature",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual",
          maintainContext: true
        },
        prd: {
          prompt: "Create a PRD",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual"
        },
        createTickets: {
          prompt: "",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual"
        },
        design: {
          prompt: "",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual"
        },
        build: {
          prompt: "",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual"
        },
        merge: {
          prompt: "",
          allowedTools: ["read"],
          model: "",
          terminationCondition: "manual"
        }
      }
    }
  }
}
