const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AGENT_RUNTIMES = Object.freeze(["native", "deepagents"]);

export function selectAgentRuntime(requested = "auto", capabilities = {}, rollout = {}) {
  const preference = String(requested || "auto").toLowerCase();
  if (!["auto", ...AGENT_RUNTIMES].includes(preference)) {
    throw new TypeError("agent runtime must be auto, native, or deepagents");
  }
  const advertised = new Set(Array.isArray(capabilities.agent_runtimes)
    ? capabilities.agent_runtimes.map((value) => String(value).toLowerCase())
    : []);
  if (preference === "auto") {
    if (!advertised.has("deepagents")) return "native";
    const percent = Math.max(0, Math.min(100, Number(rollout.deepAgentsPercent ?? 100)));
    return stableBucket(String(rollout.subject || "default")) < percent ? "deepagents" : "native";
  }
  if (preference === "native") return "native";
  if (!advertised.has("deepagents")) {
    throw new Error("the connected MundusX runner does not advertise the deepagents runtime");
  }
  return "deepagents";
}

export function createDeepAgentsRuntime(options = {}) {
  return new DeepAgentsRuntime(options);
}

export class DeepAgentsRuntime {
  constructor({ model, createTools, systemPrompt, checkpointer, backend, interruptOn, agentFactory } = {}) {
    if (!model) throw new TypeError("Deep Agents runtime requires an explicit model");
    if (createTools && typeof createTools !== "function") throw new TypeError("createTools must be a function");
    this.model = model;
    this.createTools = createTools || (() => []);
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.checkpointer = checkpointer;
    this.backend = backend;
    this.interruptOn = interruptOn;
    this.agentFactory = agentFactory;
  }

  async run(task, { emit = async () => {}, resume = false } = {}) {
    const request = normalizeTask(task);
    const candidateTools = await this.createTools({
      authority: request.authority,
      allowMutations: request.allowMutations,
      taskId: request.taskId,
      userId: request.userId,
    });
    if (!Array.isArray(candidateTools)) throw new TypeError("createTools must return an array");
    const tools = filterAuthorityTools(candidateTools, request.authority, request.allowMutations);

    const createAgent = this.agentFactory || await defaultAgentFactory();
    const agent = await createAgent(compact({
      model: this.model,
      tools,
      systemPrompt: this.systemPrompt,
      checkpointer: this.checkpointer,
      backend: this.backend,
      interruptOn: this.interruptOn,
    }));
    await emit({ type: "runtime.started", runtime: "deepagents", session_id: request.sessionId });
    const input = { messages: [...request.history, { role: "user", content: request.prompt }] };
    const config = {
      configurable: { thread_id: request.sessionId },
      metadata: {
        mundusx_task_id: request.taskId,
        mundusx_user_id: request.userId,
        mundusx_allow_mutations: request.allowMutations,
        mundusx_resume: resume,
      },
    };
    const result = await invokeWithEvents(agent, input, config, emit);
    const normalized = normalizeResult(result, request);
    await emit({ type: "runtime.completed", runtime: "deepagents", session_id: request.sessionId });
    return normalized;
  }

  async resume(task, options) {
    return this.run(task, { ...options, resume: true });
  }
}

export async function createLocalChatModel({ baseUrl = "http://127.0.0.1:11436/v1", apiKey = "mundusx-local", model = "mundusx-agent", temperature = 0 } = {}) {
  const { ChatOpenAI } = await import("@langchain/openai");
  return new ChatOpenAI({ model, temperature, apiKey, configuration: { baseURL: baseUrl } });
}

export function filterAuthorityTools(tools, authority = {}, allowMutations = false) {
  const allowed = new Set(Array.isArray(authority.allowed_operations) ? authority.allowed_operations : []);
  return tools.filter((candidate) => {
    const operation = String(candidate.operation || candidate.name || "").replaceAll("_", ".");
    if (!allowed.has(operation)) return false;
    return allowMutations || candidate.readOnly === true || candidate.metadata?.read_only === true;
  });
}

export function normalizeRuntimeEvent(value) {
  const raw = Array.isArray(value) && value.length === 2 ? value[1] : value;
  const type = raw?.type || raw?.event || (raw?.messages ? "model.message" : "runtime.progress");
  const safe = { type: String(type).slice(0, 64) };
  if (raw?.name) safe.name = String(raw.name).slice(0, 128);
  if (raw?.status) safe.status = String(raw.status).slice(0, 32);
  if (raw?.metadata && typeof raw.metadata === "object") safe.metadata = sanitizeMetadata(raw.metadata);
  return safe;
}

export function evaluateRuntimePair(nativeResult, deepAgentsResult) {
  const score = (value) => {
    const output = String(value?.output || "").trim();
    return { completed: output.length > 0, output_chars: output.length, error: value?.error ? String(value.error) : null };
  };
  return { native: score(nativeResult), deepagents: score(deepAgentsResult) };
}

async function invokeWithEvents(agent, input, config, emit) {
  if (typeof agent.stream !== "function") return agent.invoke(input, config);
  let final;
  for await (const update of await agent.stream(input, { ...config, streamMode: "updates" })) {
    final = Array.isArray(update) && update.length === 2 ? update[1] : update;
    await emit(normalizeRuntimeEvent(update));
  }
  return final || { messages: [] };
}

function sanitizeMetadata(metadata) {
  const result = {};
  for (const key of ["tool", "step", "status", "subagent", "checkpoint"]) {
    if (metadata[key] != null) result[key] = String(metadata[key]).slice(0, 256);
  }
  return result;
}

function stableBucket(subject) {
  let hash = 2166136261;
  for (const character of subject) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % 100;
}

async function defaultAgentFactory() {
  const { createDeepAgent } = await import("deepagents");
  return createDeepAgent;
}

function normalizeTask(task = {}) {
  const taskId = String(task.task_id || task.taskId || "");
  const sessionId = String(task.session_id || task.sessionId || "");
  const userId = String(task.user_id || task.userId || "");
  const prompt = String(task.prompt || "").trim();
  if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(userId)) {
    throw new TypeError("Deep Agents task, session, and user identities must be UUIDs");
  }
  if (!prompt || prompt.length > 16000) throw new TypeError("Deep Agents prompt must contain 1 to 16000 characters");
  if (!task.authority || typeof task.authority !== "object") {
    throw new TypeError("Deep Agents tasks require MundusX tool authority");
  }
  return {
    taskId,
    sessionId,
    userId,
    prompt,
    authority: Object.freeze({ ...task.authority }),
    allowMutations: task.allow_mutations === true || task.allowMutations === true,
    history: normalizeHistory(task.history),
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).flatMap((turn) => {
    const prompt = String(turn?.prompt || "").slice(0, 16000);
    const output = String(turn?.output || turn?.result?.content || "").slice(0, 32000);
    return [
      ...(prompt ? [{ role: "user", content: prompt }] : []),
      ...(output ? [{ role: "assistant", content: output }] : []),
    ];
  });
}

function normalizeResult(result, request) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const last = [...messages].reverse().find((message) => message?.content != null);
  const output = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  return {
    runtime: "deepagents",
    task_id: request.taskId,
    session_id: request.sessionId,
    output,
  };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

const DEFAULT_SYSTEM_PROMPT = `You are the MundusX coding agent. Plan and complete the requested work using only the tools supplied for this task. Tool availability is the source of authority. Never claim access beyond those tools, and never attempt to bypass their repository, path, mutation, validation, or approval boundaries.`;
