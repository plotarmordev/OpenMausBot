import { APPLIES_OUTCOME } from "./agents-catalog-copy.ts";

export const MODEL_TOOL_DEFINITIONS = [
  {
    name: "propose_model",
    description:
      "Submit a user-requested switch of this bot's default engine and model. Use the exact instance and model ids the person named, or for a Chief the ids from the team-setup catalog. The result warns about capabilities the switch gains or loses; existing threads keep their current models." + APPLIES_OUTCOME,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        model_selection: {
          type: "object",
          additionalProperties: false,
          properties: {
            instanceId: { type: "string", minLength: 1, description: "Engine instance id, for example codex or claude." },
            model: { type: "string", minLength: 1, description: "Exact model id on that instance." },
            effort: { type: "string", description: "Optional effort level the instance offers; omit for the engine default." },
            variant: { type: "string", description: "Optional explicit model variant; choose this or effort, not both." },
          },
          required: ["instanceId", "model"],
          description: "The new default selection.",
        },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "One sentence the user will see explaining why." },
        for_bot_id: {
          type: "string",
          description: "Chief of Staff only: the id of another bot in your section whose default model this changes. Omit to change your own.",
        },
      },
      required: ["model_selection", "reason"],
    },
  },
  {
    name: "get_thread_model",
    description: "Chief only: inspect your own conversation or an accessible delegated task's bot default, stored override, current execution evidence and next-turn selection. Omit thread_id for this conversation. An agent-default alias is not a resolved runtime model. Nothing runs or changes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        thread_id: { type: "string", description: "Conversation from list_threads; omit for this conversation." },
      },
    },
  },
  {
    name: "set_thread_model",
    description:
      "Chief only: change your own conversation or a managed bot-opened task's catalog-valid engine, model and supported effort for its next turn. Other bots' person-started threads are not yours to change. Use exact ids from list_team_setup. A running turn keeps its captured model; the receipt distinguishes current execution from next-turn selection. This never resumes a blocked task: use retry_thread separately only when explicitly requested. Use propose_model to change a bot default instead." + APPLIES_OUTCOME,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        thread_id: { type: "string", minLength: 1, description: "The conversation to retarget, from list_threads or a coordinate_bots receipt." },
        model_selection: {
          type: "object",
          additionalProperties: false,
          properties: {
            instanceId: { type: "string", minLength: 1, description: "Engine instance id, for example codex or claude." },
            model: { type: "string", minLength: 1, description: "Exact model id on that instance." },
            effort: { type: "string", description: "Optional effort level the instance offers; omit for the engine default." },
            variant: { type: "string", description: "Optional explicit model variant; choose this or effort, not both." },
          },
          required: ["instanceId", "model"],
          description: "The selection that conversation's next turn runs on.",
        },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "One sentence the user will see explaining why." },
      },
      required: ["thread_id", "model_selection", "reason"],
    },
  },
];
