import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { localCapability } from "../capabilities.js";
import { fail, ok } from "../result.js";
import { laneCall } from "./lane.js";

export function registerFeedback(server: McpServer): void {
  server.registerTool(
    "fillo_send_feedback",
    {
      title: localCapability("fillo_send_feedback").title,
      description: localCapability("fillo_send_feedback").description,
      inputSchema: z
        .object({
          message: z
            .string()
            .trim()
            .min(1)
            .max(6000)
            .describe("Your feedback about Fillo. Do not include secrets or respondent data."),
          category: z.enum(["bug", "idea", "other"]).optional(),
          context: z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe("Optional reproduction steps, tool name, or safe error details."),
        })
        .strict(),
      annotations: localCapability("fillo_send_feedback").annotations,
    },
    async (input) => {
      const call = await laneCall(
        { path: "/feedback", method: "POST", body: input },
        { scope: "forms:read", fallback: "Feedback could not be delivered" },
      );
      if (!call.ok) return call.result;
      if (call.res.json?.status !== "sent") {
        return fail(
          "Feedback delivery could not be verified. Check the Fillo service before retrying.",
        );
      }
      return ok("Feedback emailed to the Fillo team.", { status: "sent" });
    },
  );
}
