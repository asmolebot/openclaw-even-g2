import { spawn } from "node:child_process";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const DEFAULT_SESSION_KEY = "agent:main:even-g2";
const DEFAULT_ROUTE_PREFIX = "/even-g2";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RESPONSE_CHARS = 1800;
const DEFAULT_OPENCLAW_BIN = "openclaw";
const MAX_BODY_BYTES = 256 * 1024;
const configSchema = Type.Object({
    apiKey: Type.Optional(Type.String({ description: "Bearer token expected from the Even G2 app." })),
    agent: Type.Optional(Type.String({ description: "OpenClaw agent id to run. Defaults to gateway routing/default." })),
    model: Type.Optional(Type.String({ description: "Optional model override for glasses requests." })),
    sessionKey: Type.Optional(Type.String({ description: "Persistent OpenClaw session key for glasses chat." })),
    routePrefix: Type.Optional(Type.String({ description: "HTTP route prefix. Defaults to /even-g2." })),
    timeoutSeconds: Type.Optional(Type.Number({ description: "Agent command timeout in seconds." })),
    maxResponseChars: Type.Optional(Type.Number({ description: "Maximum assistant text returned to glasses." })),
    openclawBin: Type.Optional(Type.String({ description: "OpenClaw CLI binary path. Defaults to openclaw." })),
});
function json(res, status, body) {
    setCorsHeaders(res);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
    return true;
}
function sse(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
}
function options(res) {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
}
function routePrefix(config) {
    const raw = config.routePrefix?.trim() || DEFAULT_ROUTE_PREFIX;
    return raw.startsWith("/") ? raw.replace(/\/+$/, "") || DEFAULT_ROUTE_PREFIX : `/${raw.replace(/\/+$/, "")}`;
}
function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string")
        return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() || null;
}
function authorize(req, config) {
    if (!config.apiKey)
        return true;
    return bearerToken(req) === config.apiKey;
}
async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.byteLength;
            if (total > MAX_BODY_BYTES)
                return { ok: false, status: 413, message: "request body too large" };
            chunks.push(buffer);
        }
    }
    catch {
        return { ok: false, status: 400, message: "failed to read request body" };
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim())
        return { ok: false, status: 400, message: "request body must be JSON" };
    try {
        return { ok: true, body: JSON.parse(raw) };
    }
    catch {
        return { ok: false, status: 400, message: "request body must be valid JSON" };
    }
}
function stringifyContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
                return part.text;
            return "";
        })
            .filter(Boolean)
            .join("\n");
    }
    return "";
}
export function promptFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return "";
    const rendered = messages
        .map((message) => {
        const text = stringifyContent(message.content).trim();
        if (!text)
            return "";
        const role = typeof message.role === "string" && message.role.trim() ? message.role.trim() : "user";
        return `${role}: ${text}`;
    })
        .filter(Boolean);
    return rendered.join("\n\n").trim();
}
export function textFromAgentJson(result) {
    const payloadText = result.result?.payloads
        ?.map((payload) => payload.text ?? payload.content ?? payload.message ?? "")
        .find((text) => typeof text === "string" && text.trim());
    return (payloadText ??
        result.text ??
        result.output ??
        result.message ??
        result.content ??
        result.result?.text ??
        result.result?.output ??
        result.result?.message ??
        result.result?.content ??
        "");
}
export function normalizeGlassesText(text) {
    return text
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
        .replace(/[*_`>#~]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
async function runAgent(prompt, config) {
    const args = [
        "agent",
        "--json",
        "--session-key",
        config.sessionKey?.trim() || DEFAULT_SESSION_KEY,
        "--message",
        prompt,
        "--timeout",
        String(Math.max(1, Math.floor(config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS))),
    ];
    if (config.agent?.trim())
        args.push("--agent", config.agent.trim());
    if (config.model?.trim())
        args.push("--model", config.model.trim());
    return new Promise((resolve, reject) => {
        const child = spawn(config.openclawBin?.trim() || DEFAULT_OPENCLAW_BIN, args, {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error((stderr || stdout || `openclaw agent exited with code ${code}`).trim()));
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(textFromAgentJson(parsed).trim() || stdout.trim());
            }
            catch {
                resolve(stdout.trim());
            }
        });
    });
}
function truncateForGlasses(text, config) {
    const max = Math.max(1, Math.floor(config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS));
    const normalized = normalizeGlassesText(text);
    if (normalized.length <= max)
        return normalized;
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function chatCompletionResponse(text, model) {
    const created = Math.floor(Date.now() / 1000);
    return {
        id: `chatcmpl-even-g2-${created}`,
        object: "chat.completion",
        created,
        model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
            },
        ],
    };
}
async function handleChatCompletions(req, res, config) {
    if ((req.method ?? "GET").toUpperCase() === "OPTIONS")
        return options(res);
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: { message: "Method Not Allowed" } });
    }
    if (!authorize(req, config))
        return json(res, 401, { error: { message: "Unauthorized" } });
    const body = await readJsonBody(req);
    if (!body.ok)
        return json(res, body.status, { error: { message: body.message } });
    const chatBody = body.body;
    const prompt = promptFromMessages(chatBody.messages);
    if (!prompt)
        return json(res, 400, { error: { message: "messages must contain text" } });
    try {
        const reply = truncateForGlasses(await runAgent(prompt, config), config);
        const response = chatCompletionResponse(reply, chatBody.model || config.model || "openclaw-even-g2");
        if (chatBody.stream) {
            setCorsHeaders(res);
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            sse(res, {
                id: response.id,
                object: "chat.completion.chunk",
                created: response.created,
                model: chatBody.model || config.model || "openclaw-even-g2",
                choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
            });
            sse(res, {
                id: response.id,
                object: "chat.completion.chunk",
                created: response.created,
                model: chatBody.model || config.model || "openclaw-even-g2",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            res.end("data: [DONE]\n\n");
            return true;
        }
        return json(res, 200, response);
    }
    catch (error) {
        return json(res, 502, { error: { message: error instanceof Error ? error.message : "OpenClaw agent request failed" } });
    }
}
function createStatus(config) {
    return {
        ok: true,
        plugin: "even-g2",
        routePrefix: routePrefix(config),
        sessionKey: config.sessionKey?.trim() || DEFAULT_SESSION_KEY,
        auth: config.apiKey ? "bearer" : "disabled",
        maxResponseChars: config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS,
    };
}
export default definePluginEntry({
    id: "even-g2",
    name: "Even G2",
    description: "OpenClaw bridge for Even G2 smart glasses.",
    configSchema: configSchema,
    register(api) {
        const config = (api.pluginConfig ?? {});
        const prefix = routePrefix(config);
        api.registerHttpRoute({
            path: `${prefix}/health`,
            auth: "plugin",
            match: "exact",
            handler: async (req, res) => ((req.method ?? "GET").toUpperCase() === "OPTIONS" ? options(res) : json(res, 200, createStatus(config))),
        });
        api.registerHttpRoute({
            path: `${prefix}/v1/chat/completions`,
            auth: "plugin",
            match: "exact",
            handler: async (req, res) => handleChatCompletions(req, res, config),
        });
        api.registerHttpRoute({
            path: prefix,
            auth: "plugin",
            match: "exact",
            handler: async (req, res) => handleChatCompletions(req, res, config),
        });
        api.registerHttpRoute({
            path: `${prefix}/`,
            auth: "plugin",
            match: "exact",
            handler: async (req, res) => handleChatCompletions(req, res, config),
        });
        api.registerTool({
            name: "even_g2_status",
            label: "Even G2 Status",
            description: "Show the Even G2 bridge configuration status.",
            parameters: Type.Object({}),
            async execute() {
                return {
                    details: createStatus(config),
                    content: [{ type: "text", text: JSON.stringify(createStatus(config), null, 2) }],
                };
            },
        });
        api.registerTool({
            name: "even_g2_ask",
            label: "Even G2 Ask",
            description: "Run a short prompt through the same OpenClaw session used by Even G2.",
            parameters: Type.Object({
                prompt: Type.String({ description: "Prompt to run through the Even G2 session." }),
            }),
            async execute(_toolCallId, params) {
                const { prompt } = params;
                const reply = truncateForGlasses(await runAgent(prompt, config), config);
                return { details: { reply }, content: [{ type: "text", text: reply }] };
            },
        });
    },
});
