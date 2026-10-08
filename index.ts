/**
 * Prompt Router — OpenCode plugin (V1 and V2)
 *
 * On each user message, scores all discovered SKILL.md files against the
 * prompt and tells the model to load the top matching skills.
 *
 * Skill paths auto-detected (in order):
 *   ~/.agents/skills/      (shared cross-agent skills)
 *   ~/.claude/skills/      (Claude Code skills, if present)
 *   <workdir>/.opencode/skills/  (project-local skills)
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import { Plugin } from "@opencode/plugin";
import { createPromptRouterEngine, logError, PREAMBLE_MARKER, type PromptRouterOptions } from "./engine";

export type { PromptRouterOptions } from "./engine";

export const PromptRouter: V1Plugin = async ({ directory, client }, options?: PromptRouterOptions) => {
  const log = async (msg: string) => {
    await client.app.log({ body: { service: "prompt-router", level: "info", message: msg } });
  };
  const engine = createPromptRouterEngine(directory, options as PromptRouterOptions | undefined, log);
  // The V1 transform hook has no sessionID in its input
  let lastSeenSessionID: string | undefined;

  return {
    "chat.message": async (input, output) => {
      try {
        const promptText = output.parts
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? p.text : ""))
          .join(" ");
        lastSeenSessionID = input.sessionID;
        const preamble = await engine.routeUserPrompt(input.sessionID, promptText);
        if (!preamble) return;

        // When debug is on, show it in the chat so you can see what the router picked.
        output.parts.push({
          id: `prt_prompt-router-${Date.now()}`,
          sessionID: input.sessionID,
          messageID: input.messageID ?? "",
          type: "text" as const,
          text: preamble + "\n\n",
          synthetic: !engine.debug,
        });
      } catch (err) {
        logError("chat.message", err);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = output.messages;
        if (messages.length < 2 || !lastSeenSessionID) return;

        const lastAssistant = messages.findLast((m) => (m.info as any).role === "assistant");
        if (!lastAssistant) return;
        const assistantText = lastAssistant.parts
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? (p as any).text : ""))
          .join(" ");

        const lastUser = messages.findLast((m) => (m.info as any).role === "user");
        if (!lastUser) return;
        const alreadyInjected = lastUser.parts.some(
          (p) => p.type === "text" && "text" in p && (p as any).text?.includes(PREAMBLE_MARKER),
        );
        if (alreadyInjected) return;

        const preamble = await engine.routeAssistantText(lastSeenSessionID, assistantText);
        if (!preamble) return;

        lastUser.parts.push({
          id: `prt_prompt-router-transform-${Date.now()}`,
          sessionID: lastSeenSessionID,
          messageID: "",
          type: "text" as const,
          text: preamble + "\n\n",
          synthetic: true,
        } as any);
      } catch (err) {
        logError("transform", err);
      }
    },
  };
};

const engineLog = (msg: string) => console.log(msg);

const v2 = Plugin.define({
  id: "opencode-prompt-router",
  async setup(ctx) {
    const engine = createPromptRouterEngine(
      ctx.location.directory,
      ctx.options as PromptRouterOptions,
      engineLog,
    );
    // Preambles for the current turn, re-sent on every model request until the next user prompt.
    const pending = new Map<string, string[]>();

    await ctx.session.hook("prompt", async (event) => {
      try {
        pending.delete(event.sessionID);
        const preamble = await engine.routeUserPrompt(event.sessionID, event.prompt.text);
        if (!preamble) return;
        if (engine.debug) {
          // Visible and persisted in the prompt so you can see what the router picked.
          event.prompt.text = `${event.prompt.text}\n\n${preamble}`;
        } else {
          pending.set(event.sessionID, [preamble]);
        }
      } catch (err) {
        logError("prompt", err);
      }
    });

    await ctx.session.hook("context", async (event) => {
      try {
        const lastAssistant = event.messages.findLast((m) => m.role === "assistant");
        if (lastAssistant) {
          const assistantText = lastAssistant.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(" ");
          const preamble = await engine.routeAssistantText(event.sessionID, assistantText);
          if (preamble) pending.set(event.sessionID, [...(pending.get(event.sessionID) ?? []), preamble]);
        }
        for (const preamble of pending.get(event.sessionID) ?? []) {
          event.system.push({ type: "text", text: preamble });
        }
      } catch (err) {
        logError("context", err);
      }
    });
  },
});

export default {
  ...v2,
  server: PromptRouter,
};
