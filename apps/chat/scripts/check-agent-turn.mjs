import {createRequire} from "node:module";
import {createServer} from "node:http";
import assert from "node:assert/strict";
import {page,configFromEnv} from "../src/main.js";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const server=createServer((req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(page({...configFromEnv(),harnessUiEnabled:true}));});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
try {
 for (const scenario of ["normal", "broken-progress", "restore-completed", "restore-failed"]) {
 const tab=await browser.newPage(); const errors=[],submitted=[]; let polls=0;
 tab.on("pageerror",e=>errors.push(e.message));
 await tab.route("**/assets/**",r=>r.fulfill({body:""}));
 await tab.route("**/api/**",r=>{
  const path=new URL(r.request().url()).pathname; let body={};
  if(path==="/api/auth/session") body={user:{id:"test-user",email:"test@example.test"},csrf_token:"test"};
  if(path==="/api/agent/status") body={online:true,connections:[{online:true,capabilities:{agent_runtimes:["hermes"],preferred_agent:"hermes"}}]};
  if(path==="/api/agent/tasks") {submitted.push(r.request().postDataJSON());body={task_id:"test-task",state:"queued",events:[]};}
  if(path==="/api/agent/tasks/test-task") {polls++;body={task_id:"test-task",state:scenario==="restore-failed"?"failed":scenario==="restore-completed"?"completed":polls<6?"running":"completed",runtime_selected:"hermes",events:[{sequence:1,event:{type:"tool_started",metadata:{activity:"inspect"}}}],error:scenario==="restore-failed"?"The model connection failed":null,result:{content:"Navbar corrected and verified."}};}
  return r.fulfill({contentType:"application/json",body:JSON.stringify(body)});
 });
 await tab.goto("http://127.0.0.1:"+server.address().port);
 await tab.waitForFunction(()=>document.querySelector("#account-widget")?.hidden===false);
 if (scenario.startsWith("restore-")) {
  await tab.evaluate(async()=>{
   activeHistoryId="restore-conversation";
   localStorage.setItem(activeAgentTaskKey,JSON.stringify({taskId:"test-task",conversationId:activeHistoryId,message:"correct my project",runtimeLabel:"Hermes"}));
   await resumePersistedLocalAgentTask();
  });
  assert.match(await tab.locator("#messages").innerText(),scenario==="restore-failed"?/The model connection failed/:/Navbar corrected and verified/);
  assert.equal(submitted.length,0,"recovery must not submit another task");
  assert.equal(await tab.evaluate(()=>localStorage.getItem(activeAgentTaskKey)),null);
 } else {
 await tab.evaluate(()=>{activeProject={slug:"fe"};saveProjectPermission("fe","full");});
 if(scenario==="broken-progress") await tab.evaluate(()=>{describeAgentProgress=()=>{throw new Error("Simulated telemetry rendering failure");};});
 await tab.locator("#prompt").fill("i dont see my nav bar, pls correct my project");
 await tab.locator("#send").click();
 await tab.waitForTimeout(1500);
 assert.match(await tab.locator(".message.assistant").last().innerText(),scenario==="broken-progress"?/Checking this task for updates/:/Inspecting the codebase/);
 await tab.waitForTimeout(2500);
 assert.match(await tab.locator(".message.assistant").last().innerText(),/Navbar corrected and verified/);
 assert.equal(submitted.length,1);
 assert.equal(submitted[0].allow_mutations,true);
 assert.equal(submitted[0].runtime,"hermes");
 assert.equal(submitted[0].prompt,"i dont see my nav bar, pls correct my project");
 }
 assert.deepEqual(errors,[]);
 await tab.close();
 console.log("Project task browser check passed:",scenario);
 }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
