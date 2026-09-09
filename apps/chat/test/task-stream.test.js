import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {streamAgentTask} from "../src/features/agent/task-stream.js";
import {createLocalAgentHttpController} from "../src/features/agent/http-controller.js";

class Response extends EventEmitter {
  chunks=[];
  writeHead(status,headers){this.status=status;this.headers=headers;}
  write(text){this.chunks.push(text);return true;}
  end(){this.ended=true;}
}
test("task stream emits an answer before completion and ends on cancellation",async()=>{
  const response=new Response();
  await streamAgentTask(response,{state:"running",answer:{text:"Partial"}},async()=>({state:"cancelled"}),{interval:1});
  assert.equal(response.chunks.length,2);
  assert.match(response.chunks[0],/Partial/);
  assert.match(response.chunks[1],/cancelled/);
  assert.equal(response.ended,true);
});
test("disconnect stops reads without cancelling the task",async()=>{
  const response=new Response();let reads=0;
  response.write=(text)=>{response.chunks.push(text);queueMicrotask(()=>response.emit("close"));return true;};
  await streamAgentTask(response,{state:"running"},async()=>{reads++;},{interval:50});
  assert.equal(reads,0);
});
test("stream authorizes ownership before writing SSE headers",async()=>{
  const response=new Response();
  const controller=createLocalAgentHttpController({authStore:{session:async()=>({id:"owner"}),localAgentTask:async(user)=>{assert.equal(user,"owner");throw new Error("not found");}},readJsonBody:async()=>({}),sendJson(){}});
  await assert.rejects(controller({request:{method:"GET"},response,url:new URL("https://example.test/api/agent/tasks/123e4567-e89b-42d3-a456-426614174000/stream")}),/not found/);
  assert.equal(response.status,undefined);
});
