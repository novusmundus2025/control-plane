// Run with Playwright installed, or set PLAYWRIGHT_MODULE to its package path.
import {createRequire} from "node:module";
import {createServer} from "node:http";
import assert from "node:assert/strict";
import {page,configFromEnv} from "../src/main.js";
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const user = {id:"11111111-1111-4111-8111-111111111111",email:"test@example.test",display_name:"Startup Test"};
const server = createServer((req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(page({...configFromEnv(),harnessUiEnabled:true}));});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({headless:true});
try {
  for (const authenticated of [false,true]) {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(5000);
    const errors = [], requests = [];
    tab.on("pageerror",error=>errors.push(error.message));
    await tab.route("**/assets/**",route=>route.fulfill({contentType:"application/javascript",body:""}));
    await tab.route("**/api/**",route=>{
      const path = new URL(route.request().url()).pathname; requests.push(path);
      let status=200,body={};
      if(path==="/api/auth/providers") body={google:true};
      if(path==="/api/auth/session") {status=authenticated?200:401;body=authenticated?{user,csrf_token:"test"}:{error:"Sign in required"};}
      return route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    });
    await tab.addInitScript(({user})=>{
      for(const namespace of ["anonymous",user.id]) {
        localStorage.setItem("mundusx.chat.localProjects.v1:"+namespace,JSON.stringify(["fe","frontendtest"]));
        localStorage.setItem("mundusx.chat.activeProject.v1:"+namespace,JSON.stringify({slug:"fe"}));
      }
    },{user});
    await tab.goto("http://127.0.0.1:"+server.address().port);
    await tab.waitForFunction(()=>document.querySelector("#history-list")?.textContent.trim());
    assert.deepEqual(errors,[],"saved projects must not crash startup");
    assert.ok(requests.includes("/api/auth/session"),"startup must reach session restoration");
    assert.equal(await tab.locator("#account-widget").isVisible(),authenticated);
    assert.equal(await tab.locator("#guest-widget").isVisible(),!authenticated);
    await tab.locator("#repository-open").click();
    const anchor = tab.getByRole("button",{name:"Actions for fe",exact:true});
    await anchor.click();
    const menu = tab.locator(".project-actions-popover");
    await menu.waitFor({state:"visible"});
    assert.equal(await tab.locator("dialog[open]").count(),0,"ellipsis is a popover, not a modal");
    const bounds = await menu.boundingBox();
    assert.ok(bounds.width <= 240 && bounds.y >= 0 && bounds.y + bounds.height <= 720);
    await tab.keyboard.press("Escape");
    assert.equal(await menu.count(),0);
    assert.equal(await anchor.getAttribute("aria-expanded"),"false");
    await anchor.click();
    await tab.getByRole("button",{name:"Actions for frontendtest",exact:true}).click();
    assert.equal(await menu.count(),1,"switching projects replaces the menu");
    assert.equal(await menu.getAttribute("aria-label"),"Actions for frontendtest");
    await tab.locator("#theme-light").click();
    assert.equal(await menu.count(),0,"outside click dismisses the menu");
    assert.deepEqual(errors,[]);
    await tab.close();
    console.log("Saved-project startup passed:",authenticated?"signed in":"guest");
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
