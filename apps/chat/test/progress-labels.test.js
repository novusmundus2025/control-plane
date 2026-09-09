import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/features/agent/progress-labels.js",import.meta.url),"utf8"),context);
const describe = context.describeAgentProgress;

test("progress distinguishes model calls, program execution and verification",()=>{
  assert.equal(describe({type:"model_requested"}).source,"Model");
  const run=describe({type:"tool_started",metadata:{tool:"terminal",activity:"run"}});
  assert.equal(run.label,"Running the program"); assert.equal(run.source,"Tool");
  assert.match(describe({type:"tool_started",metadata:{activity:"test"}}).label,/Running tests/);
  assert.match(describe({type:"tool_started",metadata:{verification:true}}).label,/verification/);
});
test("failed and unknown tool results are never reported as successful",()=>{
  for (const [success,outcome] of [[false,"failed"],[null,"unknown"],[true,"succeeded"]]) {
    const result=describe({type:"tool_completed",metadata:{activity:"build",success}},true);
    assert.equal(result.outcome,outcome); assert.match(result.purpose,/tool has finished/);
    if(success!==true) assert.doesNotMatch(result.label,/succeeded/);
  }
});
