import {createRequire} from "node:module";
import {createServer} from "node:http";
import assert from "node:assert/strict";
import {page,configFromEnv} from "../src/main.js";
import {streamAgentTask} from "../src/features/agent/task-stream.js";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const taskId="123e4567-e89b-42d3-a456-426614174000";
let state="queued", submissions=0, streams=0;
const payload=()=>({task_id:taskId,state,runtime_selected:"hermes",events:[{sequence:2,event:{type:"tool_started",metadata:{activity:"inspect"}}}],answer:{sequence:1,event:{type:"assistant_snapshot",metadata:{text:"I found the navigation component."}}},result:{content:"The navigation is fixed."}});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,"http://localhost");
 const json=body=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(body));};
 if(url.pathname.endsWith("/stream")) {
  streams++;
  // Short connection lifetime exercises reconnects and duplicate snapshots.
  await streamAgentTask(res,payload(),async()=>payload(),{interval:50,lifetime:200});return;
 }
 if(url.pathname==="/api/auth/session") return json({user:{id:"test-user",email:"test@example.test"},csrf_token:"test"});
 if(url.pathname==="/api/agent/status") return json({online:true,connections:[{online:true,capabilities:{agent_runtimes:["hermes"],preferred_agent:"hermes"}}]});
 if(url.pathname==="/api/agent/tasks" && req.method==="POST") {submissions++;state="running";return json(payload());}
 if(url.pathname.endsWith("/cancel")) {state="cancelled";return json(payload());}
 if(url.pathname==="/api/agent/tasks/"+taskId) return json(payload());
 if(url.pathname.startsWith("/api/")) return json({});
 if(url.pathname.startsWith("/assets/")) {res.end("");return;}
 res.setHeader("content-type","text/html; charset=utf-8");res.end(page({...configFromEnv(),harnessUiEnabled:true}));
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
try {
 for(const scenario of ["completion", "refresh", "cancel"]) {
  state="queued";submissions=0;streams=0;
  const tab=await browser.newPage();const errors=[];
  tab.on("pageerror",e=>errors.push(e.message));
  await tab.goto("http://127.0.0.1:"+server.address().port);
  await tab.waitForFunction(()=>document.querySelector("#account-widget")?.hidden===false);
  await tab.evaluate(()=>{activeProject={slug:"fe"};saveProjectPermission("fe","full");});
  await tab.locator("#prompt").fill("fix my navigation");await tab.locator("#send").click();
  await tab.locator(".agent-answer-preview").waitFor();
  assert.equal(state,"running","answer must arrive before completion");
  await tab.waitForTimeout(1100);
  assert.ok(streams>=2,"stream reconnects after disconnect");
  assert.equal((await tab.locator(".agent-answer-preview").innerText()).match(/I found/g).length,1);
  if(scenario==="refresh") {
   await tab.reload();await tab.locator(".agent-answer-preview").waitFor();
   assert.equal(submissions,1,"refresh must resume the same task");
  }
  if(scenario==="cancel") {
   await tab.getByRole("button",{name:"Stop",exact:true}).click();
   await tab.waitForFunction(()=>document.querySelector(".message.error"));
   assert.equal(state,"cancelled");
   assert.match(await tab.locator(".agent-answer-preview").innerText(),/Partial answer/);
  } else {
   state="completed";
   await tab.waitForFunction(()=>document.querySelector("#messages")?.textContent.includes("The navigation is fixed."));
   assert.equal(await tab.locator(".agent-answer-preview").count(),0,"final replaces preview");
  }
  assert.deepEqual(errors,[]);assert.equal(submissions,1);
  await tab.close();console.log("Hermes stream browser check passed:",scenario);
 }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
