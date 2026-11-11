import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBudgetReport, probePublicDictionary, main } from './measure-budgets.mjs';

test('measurement separates wall latency, billing counts and platform CPU; local inputs stay read-only', async t => {
  const root=mkdtempSync(join(tmpdir(),'inputread-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const maps=join(root,'maps');mkdirSync(maps);writeFileSync(join(maps,'mappings.json'),JSON.stringify({schema:'oewn-position-mappings-v1',entries:[{}]}));
  const log=join(root,'requests.jsonl');writeFileSync(log,[{event:'request',resource:'word',elapsedMs:12,status:200,cfCacheStatus:'HIT'},{event:'request',resource:'word',elapsedMs:25,status:304},{event:'lookup',firstDisplayMs:20}].map(x=>JSON.stringify(x)).join('\n'));
  const sync=join(root,'sync.json');writeFileSync(sync,JSON.stringify({items:[{kind:'wordbook',data:{hello:1}}]}));
  const r=buildBudgetReport({mappingsRoot:maps,requestLog:log,syncPayload:sync});
  assert.equal(r.platformCpuMs,null);assert.equal(r.r2AccountReadCount,null);assert.equal(r.requests.count,2);assert.equal(r.requests.confirmedCacheHitCount,1);assert.equal(r.requests.elapsedMs.max,25);assert.equal(r.requests.lookupFirstDisplayMs.p50,20);assert.equal(r.syncPayload.items,1);assert.equal(r.mappingFiles[0].entries,1);
  const cpu=join(root,'cpu.jsonl');writeFileSync(cpu,JSON.stringify({source:'browser',route:'/api/sync',cpuTimeMs:2}));assert.throws(()=>buildBudgetReport({platformLog:cpu}),/platform export/);
  writeFileSync(cpu,JSON.stringify({source:'cloudflare-platform-export',route:'/api/sync',cpuTimeMs:2,wallTimeMs:300}));assert.equal(buildBudgetReport({platformLog:cpu}).platformCpuMs.max,2);
  const output=join(root,'report.json');await main(['--request-log',log,'--out',output]);assert.ok(existsSync(output));await assert.rejects(main(['--request-log',log,'--out',output]),/new file/);await assert.rejects(main(['--url','https://other.invalid']),/Unknown/);
});

test('public probe is exactly two bounded fixed-host GETs and never publishes data',async()=>{
 const calls=[];const result=await probePublicDictionary(async(url,options)=>{calls.push({url,options});return new Response('{}',{headers:{'cf-cache-status':'DYNAMIC','cache-control':'no-cache'}});});
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url.startsWith('https://books.inputread.site/dictionary/')&&!c.options.body&&!c.options.headers));assert.equal(result.platformCpuMs,null);assert.equal(result.r2AccountReadCount,null);assert.equal(result.publicProbe[0].cfCacheStatus,'DYNAMIC');
});
