import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const toolContext = new AsyncLocalStorage<string>();

export function currentTool(): string | undefined {
  return toolContext.getStore();
}

/** Associate existing Fillo HTTP requests with their registered tool. No new
 * network destination, analytics key, arguments, or tool output is collected.
 * AsyncLocalStorage keeps concurrent calls from borrowing each other's name. */
export class ObservedMcpServer extends McpServer {
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ) {
    const wrapped = new Proxy(cb, {
      apply(target, thisArg, args) {
        return toolContext.run(name, () => Reflect.apply(target, thisArg, args));
      },
    });
    return super.registerTool(name, config, wrapped);
  }
}
