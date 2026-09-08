import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const configure = source.slice(source.indexOf("    function configureAgentRecoveryAction("), source.indexOf('    projectAgentUpdateEl?.addEventListener("click"'));

test("Reconnect opens the installed app without downloading; Update still downloads", () => {
  const attributes = new Map([["download", ""]]);
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ projectAgentUpdateEl: link, harnessDownloadEl: { href: "https://example.test/setup.exe" } });
  vm.runInContext(configure, context);
  context.configureAgentRecoveryAction(false, true);
  assert.equal(link.href, "mundusx://reconnect");
  assert.equal(link.dataset.action, "reconnect");
  assert.equal(attributes.has("download"), false);
  context.configureAgentRecoveryAction(true, true);
  assert.equal(link.href, "https://example.test/setup.exe");
  assert.equal(link.dataset.action, "update");
  assert.equal(attributes.has("download"), true);
});

test("recovery keeps polling when known runners are still offline", async () => {
  const code = source.slice(source.indexOf("    function pollRunnerPairing()"), source.indexOf("    async function openProjects("));
  let scheduled;
  let schedules = 0;
  const context = vm.createContext({
    stopRunnerPairingPoll() {}, runnerPairingInProgress: true,
    runnerPairingExpiresAt: Date.now() + 600000, runnerPairingPollTimer: null,
    localRunnerReady: false, loadHarnessRunners: async () => [{ ready: false, fresh: false }],
    window: { setTimeout: (callback) => { scheduled = callback; schedules++; return schedules; } },
  });
  vm.runInContext(code, context);
  context.pollRunnerPairing();
  await scheduled();
  assert.equal(context.runnerPairingInProgress, true);
  assert.equal(schedules, 2);
  context.localRunnerReady = true;
  await scheduled();
  assert.equal(context.runnerPairingInProgress, false);
  assert.equal(schedules, 2);
});
