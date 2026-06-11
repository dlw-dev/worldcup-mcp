/**
 * Worker MCP — Copa do Mundo 2026 (horários e resultados).
 *
 * Expõe um endpoint JSON-RPC 2.0 compatível com o adapter worker_proxy da
 * mcp.ai (POST /worldcup) e com clientes MCP genéricos (POST /, /mcp):
 *   - initialize
 *   - tools/list
 *   - tools/call { name, arguments }  → content[0].text = JSON.stringify(result)
 *
 * Dados: data/tournament.json (bundlado, auto-atualizado por git/cron). Sem
 * estado, sem auth: é informação pública.
 */
import { TOOLS, TOOL_DESCRIPTORS } from "./tools.js";

const SERVER_INFO = { name: "worldcup-mcp", version: "0.1.0" };

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: jsonHeaders,
  });
}
function rpcError(id, code, message) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { headers: jsonHeaders },
  );
}

function toolInputSchema(name) {
  // Schema mínimo (todos os campos opcionais) — descritivo pra tools/list.
  const props = {
    matches: {
      date: { type: "string" },
      team: { type: "string" },
      group: { type: "string" },
      stage: { type: "string" },
      status: { type: "string" },
      timezone: { type: "string" },
    },
    schedule: { date: { type: "string" }, stage: { type: "string" }, timezone: { type: "string" } },
    results: { date: { type: "string" }, team: { type: "string" }, group: { type: "string" } },
    groups: { group: { type: "string" } },
    standings: { group: { type: "string" } },
    bracket: { stage: { type: "string" } },
    teams: { team: { type: "string" }, confederation: { type: "string" } },
    venues: { city: { type: "string" }, venue: { type: "string" } },
  }[name] || {};
  return { type: "object", properties: props };
}

async function handleRpc(body) {
  const { id, method, params } = body || {};
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "tools/list":
      return rpcResult(id, {
        tools: TOOL_DESCRIPTORS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toolInputSchema(t.name),
        })),
      });
    case "tools/call": {
      const name = params?.name;
      const fn = TOOLS[name];
      if (!fn) return rpcError(id, -32601, `Unknown tool: ${name}`);
      try {
        const result = fn(params?.arguments || {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (e) {
        return rpcError(id, -32603, `Tool error: ${e.message}`);
      }
    }
    case "notifications/initialized":
      return rpcResult(id ?? null, {});
    default:
      return rpcError(id ?? null, -32601, `Unknown method: ${method}`);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS")
      return new Response(null, { headers: jsonHeaders });

    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          server: SERVER_INFO,
          tools: TOOL_DESCRIPTORS.map((t) => t.name),
          endpoint: "POST /worldcup (JSON-RPC 2.0)",
        }),
        { headers: jsonHeaders },
      );
    }

    if (request.method !== "POST")
      return rpcError(null, -32600, "Use POST");

    // Aceita /worldcup (mcp.ai proxy), / e /mcp (clientes genéricos).
    if (!["/worldcup", "/", "/mcp"].includes(url.pathname))
      return rpcError(null, -32600, `Unknown path: ${url.pathname}`);

    let body;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "Invalid JSON");
    }
    return handleRpc(body);
  },
};
