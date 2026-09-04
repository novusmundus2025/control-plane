#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { FilesystemBackend } from "deepagents/node";
import { createDeepAgentsRuntime, createLocalChatModel } from "./index.js";

async function main() {
  if (process.argv[2] !== "run-json") throw new Error("usage: mundusx-deepagents-runtime run-json --workspace <path>");
  const workspaceIndex = process.argv.indexOf("--workspace");
  const workspace = resolve(workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : ".");
  const task = JSON.parse(await readFile(0, "utf8"));
  const allowMutations = task.allow_mutations === true;
  const rawBackend = new FilesystemBackend({ rootDir: workspace, virtualMode: true, maxFileSizeMb: 1 });
  const backend = allowMutations ? rawBackend : readOnlyBackend(rawBackend);
  const events = [];
  const runtime = createDeepAgentsRuntime({
    model: await createLocalChatModel({
      baseUrl: process.env.MUNDUSX_LOCAL_MODEL_URL || "http://127.0.0.1:11436/v1",
      model: process.env.MUNDUSX_LOCAL_MODEL || "mundusx-agent",
    }),
    backend,
    checkpointer: new MemorySaver(),
  });
  const result = await runtime.run(task, { emit: async (event) => events.push(event) });
  process.stdout.write(JSON.stringify({ ...result, events: events.map((event, sequence) => ({ sequence, event })) }));
}

function readOnlyBackend(backend) {
  const blocked = new Set(["write", "edit", "delete"]);
  return new Proxy(backend, {
    get(target, property, receiver) {
      if (blocked.has(String(property))) return async () => { throw new Error("mutation requires explicit MundusX approval"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 1;
});
