import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/standard-dictionary.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = () => {
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, (id) => id === "@/lib/books-base" ? { booksUrl: (path) => `https://books.test.invalid/${path}` } : require(id));
  return module.exports;
};

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get() { return null; } }, text: async () => JSON.stringify(body) };
}
const manifest = response({ schema: "oewn-r2-current-v1", release: "oewn-2025-test" });
const entry = (word) => response({ schema: "oewn-r2-entry-v1", release: "oewn-2025-test", lookupKey: word, senses: [
  { id: "bank%1:14:00::", pos: "n", meaning: "a place for money", originalMeaning: "a financial institution", learningMeaning: "a place for money" },
  { id: "bank%1:17:00::", pos: "n", meaning: "the land beside a river", originalMeaning: "sloping land by a stream" },
] });

test("exact NFC UTF-8 hex lookup path preserves case and separators", () => {
  const { dictionaryWordPath } = load();
  assert.equal(dictionaryWordPath("oewn-2025-test", "Bank"), "dictionary/releases/oewn-2025-test/words/42/42616e6b.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "bank"), "dictionary/releases/oewn-2025-test/words/62/62616e6b.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "km/h"), "dictionary/releases/oewn-2025-test/words/6b/6b6d2f68.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "é"), dictionaryWordPath("oewn-2025-test", "é"));
  assert.throws(() => dictionaryWordPath("../bad", "bank"));
});

test("manifest gates requests, duplicate lookup coalesces, and sense IDs are never guessed", async () => {
  const { lookupStandardWord } = load();
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return url.endsWith("current.json") ? manifest : entry("bank"); };
  try {
    const [first, second] = await Promise.all([lookupStandardWord("bank"), lookupStandardWord("bank")]);
    assert.deepEqual(first, second);
    assert.equal(first.kind, "unmapped");
    assert.equal(first.senses.length, 2);
    assert.equal(first.senses[0].id, "bank%1:14:00::");
    assert.equal(first.senses[0].pos, "noun");
    assert.deepEqual(urls, ["https://books.test.invalid/dictionary/current.json", "https://books.test.invalid/dictionary/releases/oewn-2025-test/words/62/62616e6b.json"]);
  } finally { globalThis.fetch = original; }
});

test("all OEWN part-of-speech codes expand without changing sense identities or meanings", async () => {
  const original = globalThis.fetch;
  const codes = ["n", "v", "a", "s", "r", "noun", "verb", "adjective", "adverb", "", "phrase", "toString"];
  const meanings = codes.map((pos, i) => ({ id: `source-sense-${i}`, pos, meaning: `Meaning ${i}`, originalMeaning: `Original ${i}` }));
  globalThis.fetch = async url => url.endsWith("current.json") ? manifest : response({ schema: "oewn-r2-entry-v1", release: "oewn-2025-test", lookupKey: "hotel", senses: meanings });
  try {
    const result = await load().lookupStandardWord("hotel");
    assert.equal(result.kind, "unmapped");
    assert.deepEqual(result.senses.map(s => s.pos), ["noun", "verb", "adjective", "adjective", "adverb", "noun", "verb", "adjective", "adverb", "", "phrase", "toString"]);
    assert.deepEqual(result.senses.map(s => [s.id, s.meaning]), meanings.map(s => [s.id, s.meaning]));
  } finally { globalThis.fetch = original; }
});

test("existing uploaded word paths become mutable without copying files or changing book mappings", async () => {
  const native=globalThis.fetch, now=Date.now;const api=load();let clock=0,mutable=false,meaning='old wording';const urls=[];
  Date.now=()=>clock;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',...(mutable?{wordsMutable:true}:{})});
    urls.push({url,cache:options?.cache});
    assert.equal(url,'https://books.test.invalid/dictionary/releases/oewn-2025-test/words/62/62616e6b.json');
    return response({schema:'oewn-r2-entry-v1',release:mutable?'oewn-edit-new':'oewn-2025-test',lookupKey:'bank',senses:[{id:'bank-stable-id',pos:'n',meaning,originalMeaning:'original'}]});
  };
  try{
    assert.equal((await api.lookupStandardWord('bank')).senses[0].meaning,'old wording');
    mutable=true;meaning='new wording';clock=60_001;
    const fresh=await api.lookupStandardWord('bank');assert.equal(fresh.senses[0].meaning,'new wording');assert.equal(fresh.senses[0].id,'bank-stable-id');
    meaning='another wording';clock=120_002;assert.equal((await api.lookupStandardWord('bank')).senses[0].meaning,'another wording');
    assert.equal(new Set(urls.map(x=>x.url)).size,1,'same original uploaded path throughout');
    assert.equal(urls.length,3);assert.equal(urls[1].cache,'no-cache');assert.equal(urls[2].cache,'no-cache');
  }finally{globalThis.fetch=native;Date.now=now;}
});

test("stable per-word path returns all senses once and refreshes overwritten meanings without a publication change", async () => {
  const native = globalThis.fetch, now = Date.now;
  const api = load(); const calls = []; let clock = 0, meaning = 'first explanation', revision = 'oewn-edit-one';
  const pointer = { schema: 'oewn-r2-current-v1', release: 'oewn-2025-test', wordsMutable: true };
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    calls.push({url, cache:options?.cache});
    if (url.endsWith('current.json')) return response(pointer);
    assert.equal(url, 'https://books.test.invalid/dictionary/releases/oewn-2025-test/words/62/62616e6b.json');
    return response({schema:'oewn-r2-entry-v1',release:revision,lookupKey:'bank',senses:[
      {id:'stable-bank-one',pos:'n',meaning,originalMeaning:'original'},
      {id:'stable-bank-two',pos:'v',meaning:'other sense unchanged',originalMeaning:'other original'},
    ]});
  };
  try {
    const [a,b] = await Promise.all([api.lookupStandardWord('bank'),api.lookupStandardWord('bank')]);
    assert.deepEqual(a,b); assert.equal(a.senses.length,2); assert.equal(a.senses[0].source.release,'oewn-edit-one');
    assert.equal(calls.filter(x=>!x.url.endsWith('current.json')).length,1);
    meaning='updated explanation';revision='oewn-edit-two';clock=59_999;
    assert.equal((await api.lookupStandardWord('bank')).senses[0].meaning,'first explanation');
    clock=60_001;
    const latest=await api.lookupStandardWord('bank');
    assert.equal(latest.senses[0].meaning,'updated explanation');assert.equal(latest.senses[0].id,'stable-bank-one');
    assert.equal(latest.senses[1].meaning,'other sense unchanged');
    assert.equal(latest.senses[0].source.release,'oewn-edit-two');
    assert.equal(calls.filter(x=>!x.url.endsWith('current.json')).length,2);
    assert.ok(calls.every(x=>x.cache==='no-cache'),'mutable resources revalidate through HTTP cache');
  } finally {globalThis.fetch=native;Date.now=now;}
});

test("stable case aliases reuse word cache, expire missing entries and never fetch individual sense paths", async () => {
  const native=globalThis.fetch, now=Date.now;const api=load();let clock=0,revision=0;const urls=[];
  Date.now=()=>clock;
  globalThis.fetch=async url=>{
    urls.push(url);
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',caseIndex:'case-v1-0123456789ab',wordsMutable:true});
    if(url.includes('case-indexes'))return caseResponse(api,'Bank',{bank:['bank']});
    if(!url.endsWith('/62616e6b.json'))return response({},404);
    return response({schema:'oewn-r2-entry-v1',release:'oewn-2025-test',lookupKey:'bank',senses:[{id:'bank-fixed',pos:'n',meaning:'revision '+revision,originalMeaning:'original'}]});
  };
  try {
    assert.equal((await api.lookupStandardWord('Bank')).senses[0].meaning,'revision 0');
    revision=1;clock=30_000;assert.equal((await api.lookupStandardWord('bank')).senses[0].meaning,'revision 0');
    clock=60_001;assert.equal((await api.lookupStandardWord('Bank')).senses[0].meaning,'revision 1');
    assert.ok(urls.every(url=>!url.includes('/senses/')));assert.equal(urls.filter(url=>url.endsWith('/62616e6b.json')).length,2);
  }finally{globalThis.fetch=native;Date.now=now;}
});

test("stable missing words expire and failed refresh retries instead of serving stale definitions", async () => {
  const native=globalThis.fetch, now=Date.now;const api=load();let clock=0,phase=0,wordCalls=0;
  Date.now=()=>clock;
  globalThis.fetch=async url=>{
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',wordsMutable:true});
    wordCalls++;
    if(phase===0)return response({},404);
    if(phase===2)return response({},503);
    return entry('bank');
  };
  try{
    assert.equal((await api.lookupStandardWord('bank')).kind,'missing');
    phase=1;clock=60_001;assert.equal((await api.lookupStandardWord('bank')).kind,'unmapped');
    phase=2;clock=120_002;assert.equal((await api.lookupStandardWord('bank')).kind,'error');
    phase=1;assert.equal((await api.lookupStandardWord('bank')).kind,'unmapped');
    assert.equal(wordCalls,4);
  }finally{globalThis.fetch=native;Date.now=now;}
});

test("unknown word routing and invalid mutable flags fail closed", async () => {
  const native=globalThis.fetch;
  try {
    for(const extra of [{wordBase:'dictionary/words'},{wordsMutable:false},{wordsMutable:'true'},{wordsMutable:1},{wordsMutable:null}]){
      const urls=[];globalThis.fetch=async url=>{urls.push(url);return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',...extra});};
      assert.equal((await load().lookupStandardWord('bank')).kind,'error');assert.equal(urls.length,1);
    }
    globalThis.fetch=async url=>url.endsWith('current.json')?response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',wordsMutable:true}):entry('wrong');
    assert.equal((await load().lookupStandardWord('bank')).kind,'error');
  }finally{globalThis.fetch=native;}
});

const indexedManifest = response({ schema: "oewn-r2-current-v1", release: "oewn-2025-test", caseIndex: "case-v1-0123456789ab" });
function caseResponse(api, word, entries, changes = {}) {
  return response({ schema: "oewn-case-index-v1", release: "oewn-2025-test", indexVersion: "case-v1-0123456789ab", shard: api.dictionaryCaseShard(word), entries, ...changes });
}

test("case fallback is unique, exact-first and does not merge conflicting identities", async () => {
  const original = globalThis.fetch;
  try {
    for (const word of ["Bank", "BANK", "bank"]) {
      const api = load(); const urls = [];
      globalThis.fetch = async (url) => {
        urls.push(url);
        if (url.endsWith("current.json")) return indexedManifest;
        if (url.includes("case-indexes")) return caseResponse(api, word, { bank: ["bank"] });
        return url.endsWith("/62616e6b.json") ? entry("bank") : response({}, 404);
      };
      assert.equal((await api.lookupStandardWord(word)).kind, "unmapped");
      assert.equal(urls.filter(u => u.includes("case-indexes")).length, word === "bank" ? 0 : 1);
      assert.equal(urls.some(u => u.endsWith('/42616e6b.json') || u.endsWith('/42414e4b.json')), false, 'known case aliases avoid nonexistent word URLs');
    }
    for (const word of ["US", "us", "Us"]) {
      const api = load();
      globalThis.fetch = async (url) => {
        if (url.endsWith("current.json")) return indexedManifest;
        if (url.includes("case-indexes")) return caseResponse(api, word, { us: ["US", "us"] });
        return word === "Us" ? response({}, 404) : entry(word);
      };
      assert.equal((await api.lookupStandardWord(word)).kind, word === "Us" ? "ambiguous" : "unmapped");
    }
    const api = load();
    globalThis.fetch = async (url) => url.endsWith("current.json") ? indexedManifest : url.includes("case-indexes") ? caseResponse(api, "london", { london: ["London"] }) : url.endsWith("/4c6f6e646f6e.json") ? entry("London") : response({}, 404);
    assert.equal((await api.lookupStandardWord("london")).kind, "unmapped");
  } finally { globalThis.fetch = original; }
});

test("case index errors, mismatches and ambiguity fail closed; no stemming", async () => {
  const original = globalThis.fetch;
  try {
    for (const kind of ["network", "release", "candidate", "missing", "duplicate"]) {
      const api = load();
      globalThis.fetch = async url => {
        if (url.endsWith("current.json")) return indexedManifest;
        if (!url.includes("case-indexes")) return response({}, 404);
        if (kind === "network") return response({}, 503);
        return caseResponse(api, "BANK", kind === "candidate" ? { bank: ["river"] } : kind === "duplicate" ? { bank: ["bank", "bank"] } : kind === "missing" ? {} : { bank: ["bank"] }, kind === "release" ? { release: "other" } : {});
      };
      assert.equal((await api.lookupStandardWord("BANK")).kind, kind === "missing" ? "missing" : "error");
    }
    const api = load();
    globalThis.fetch = async url => url.endsWith("current.json") ? indexedManifest : url.includes("case-indexes") ? caseResponse(api, "walked", {}) : response({}, 404);
    assert.equal((await api.lookupStandardWord("walked")).kind, "missing");
    assert.equal(api.dictionaryCaseShard("İ"), api.dictionaryCaseShard("i̇"));
  } finally { globalThis.fetch = original; }
});

test("source forms and validated regular inflections resolve without fabricated meanings", async () => {
  const original = globalThis.fetch;
  try {
    const forms = {
      children: [{ lemma: "child", pos: "n" }],
      went: [{ lemma: "go", pos: "v" }],
      running: [{ lemma: "run", pos: "v" }],
      stopped: [{ lemma: "stop", pos: "v" }],
      axes: [{ lemma: "axe", pos: "n" }, { lemma: "axis", pos: "n" }],
    };
    const words = {
      learner: ["n"], child: ["n"], go: ["n", "v"], run: ["n", "v"], learn: ["v"],
      large: ["a"], stop: ["v"], axe: ["n"], axis: ["n"],
      news: ["n"], new: ["a"], stopped: ["a"], running: ["n", "a"],
    };
    const { dictionaryCaseShard, dictionaryRegularForms } = load();
    assert.ok(dictionaryRegularForms("learners").some(c => c.lemma === "learner" && c.pos === "n"));
    assert.deepEqual(dictionaryRegularForms("km/h"), []);
    for (const [word, expected, expectedPos] of [
      ["learners", "unmapped", "noun"], ["Learners", "unmapped", "noun"],
      ["children", "unmapped", "noun"], ["went", "unmapped", "verb"],
      ["running", "unmapped"], ["stopped", "unmapped"], ["learned", "unmapped", "verb"],
      ["larger", "unmapped", "adjective"], ["axes", "ambiguous"],
      ["news", "unmapped", "noun"], ["quuxstones", "missing"],
    ]) {
      const api = load();
      globalThis.fetch = async url => {
        if (url.endsWith("current.json")) return response({schema:"oewn-r2-current-v1",release:"oewn-2025-test",caseIndex:"case-v1-0123456789ab",formsIndex:"forms-v1-0123456789ab"});
        const shard = url.split("/").at(-1).replace(".json", "");
        if (url.includes("form-indexes")) return response({schema:"oewn-form-index-v1",release:"oewn-2025-test",indexVersion:"forms-v1-0123456789ab",shard,entries:Object.fromEntries(Object.entries(forms).filter(([key])=>dictionaryCaseShard(key)===shard))});
        if (url.includes("case-indexes")) return caseResponse(api, Object.keys(words).find(key=>dictionaryCaseShard(key)===shard) ?? word, Object.fromEntries(Object.keys(words).filter(key=>dictionaryCaseShard(key)===shard).map(key=>[key,[key]])), {shard});
        const hex = url.split("/").at(-1).replace(".json", "");
        const key = Buffer.from(hex,"hex").toString();
        return words[key] ? response({schema:"oewn-r2-entry-v1",release:"oewn-2025-test",lookupKey:key,senses:words[key].map((pos,i)=>({id:`${key}-source-${i}`,pos,meaning:`${key} meaning`,originalMeaning:`${key} original`}))}) : response({},404);
      };
      const result = await api.lookupStandardWord(word);
      assert.equal(result.kind, expected, word);
      if (expectedPos) assert.ok(result.senses.every(s=>s.pos===expectedPos), word+" filters only source POS");
      if (word.toLowerCase() === "learners") assert.equal(result.senses[0].id, "learner-source-0");
      if (word === "running") assert.deepEqual(result.senses.map(s=>s.pos), ["noun", "adjective", "verb"], "independent entry and inflected verb coexist");
      if (word === "stopped") assert.deepEqual(result.senses.map(s=>s.pos), ["adjective", "verb"]);
    }
  } finally { globalThis.fetch = original; }
});

test("form index identity errors cannot silently fall back to suffix guesses", async () => {
  const original = globalThis.fetch;
  try {
    const api = load();
    globalThis.fetch = async url => {
      if (url.endsWith("current.json")) return response({schema:"oewn-r2-current-v1",release:"oewn-2025-test",caseIndex:"case-v1-0123456789ab",formsIndex:"forms-v1-0123456789ab"});
      if (url.includes("case-indexes")) return caseResponse(api,"learners",{});
      if (url.includes("form-indexes")) return response({schema:"oewn-form-index-v1",release:"wrong",indexVersion:"forms-v1-0123456789ab",shard:api.dictionaryCaseShard("learners"),entries:{}});
      return response({},404);
    };
    assert.equal((await api.lookupStandardWord("learners")).kind,"error");
  } finally { globalThis.fetch = original; }
});

test("validated base senses are delivered before delayed enrichment, then all original senses merge", async () => {
  const native=globalThis.fetch;const api=load();const events=[];let releaseForms;
  const gate=new Promise(resolve=>{releaseForms=resolve;});
  globalThis.fetch=async url=>{
    events.push(url);
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',caseIndex:'case-v1-0123456789ab',formsIndex:'forms-v1-0123456789ab',wordsMutable:true});
    if(url.includes('form-indexes')){await gate;return response({schema:'oewn-form-index-v1',release:'oewn-2025-test',indexVersion:'forms-v1-0123456789ab',shard:api.dictionaryCaseShard('learned'),entries:{learned:[{lemma:'learn',pos:'v'}]}});}
    if(url.includes('case-indexes'))return caseResponse(api,'learned',{learned:['learned']});
    const key=Buffer.from(url.split('/').at(-1).replace('.json',''),'hex').toString();
    return response({schema:'oewn-r2-entry-v1',release:'oewn-2025-test',lookupKey:key,senses:[{id:key+'-id',pos:key==='learned'?'a':'v',meaning:key+' meaning',originalMeaning:'original'}]});
  };
  try{
    let partial;let done=false;
    const first=api.lookupStandardWord('learned',value=>{partial=value;}).then(r=>{done=true;return r;});
    for(let i=0;i<50&&!partial;i++)await Promise.resolve();
    assert.equal(partial?.senses[0].id,'learned-id');assert.equal(done,false);
    let joined;const second=api.lookupStandardWord('learned',r=>{joined=r;});
    for(let i=0;i<10&&!joined;i++)await Promise.resolve();
    assert.equal(joined?.senses[0].id,'learned-id','late concurrent subscriber receives available base');
    releaseForms();const[a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);
    assert.deepEqual(a.senses.map(s=>s.id),['learned-id','learn-id']);
    assert.equal(events.filter(u=>u.endsWith('/6c6561726e6564.json')).length,1);
  }finally{releaseForms();globalThis.fetch=native;}
});

test("ambiguous case and competing morphology never emit an unsafe partial match", async () => {
  const native=globalThis.fetch;const api=load();const partial=[];const urls=[];
  globalThis.fetch=async url=>{
    urls.push(url);
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',caseIndex:'case-v1-0123456789ab'});
    if(url.includes('case-indexes'))return caseResponse(api,'Us',{us:['US','us']});
    throw Error('Ambiguous alias must not fetch an entry');
  };
  try{assert.equal((await api.lookupStandardWord('Us',r=>partial.push(r))).kind,'ambiguous');assert.deepEqual(partial,[]);assert.equal(urls.some(u=>u.includes('/words/')),false);}finally{globalThis.fetch=native;}
});

test("warming is capped at four shared shard pairs, coalesced and never downloads word payloads", async () => {
  const native=globalThis.fetch;const api=load();const urls=[];
  globalThis.fetch=async url=>{
    urls.push(url);
    if(url.endsWith('current.json'))return response({schema:'oewn-r2-current-v1',release:'oewn-2025-test',caseIndex:'case-v1-0123456789ab',formsIndex:'forms-v1-0123456789ab'});
    const shard=url.split('/').at(-1).replace('.json','');
    return response({schema:url.includes('form-indexes')?'oewn-form-index-v1':'oewn-case-index-v1',release:'oewn-2025-test',indexVersion:url.includes('form-indexes')?'forms-v1-0123456789ab':'case-v1-0123456789ab',shard,entries:{}});
  };
  try{const words=['Bank','hotel','learners','children','went','running','other'];await Promise.all([api.warmStandardDictionary(words),api.warmStandardDictionary(words)]);assert.equal(urls.filter(u=>u.endsWith('current.json')).length,1);assert.ok(urls.length<=9);assert.equal(urls.some(u=>u.includes('/words/')),false);}finally{globalThis.fetch=native;}
});

test("failed requests retry and old missing manifest expires", async () => {
  const original = globalThis.fetch; const now = Date.now;
  try {
    const api = load(); let clock = 0; let phase = 0; let count = 0;
    Date.now = () => clock;
    globalThis.fetch = async url => {
      count++;
      if (phase === 0) return response({}, 404);
      if (url.endsWith("current.json")) return manifest;
      return phase === 1 ? response({}, 503) : entry("bank");
    };
    assert.equal(await api.lookupStandardWord("bank"), null);
    phase = 1; clock = 61_000;
    assert.equal((await api.lookupStandardWord("bank")).kind, "error");
    phase = 2;
    assert.equal((await api.lookupStandardWord("bank")).kind, "unmapped");
    assert.equal(count, 4, "the successful manifest is reused while only the failed entry retries");
  } finally { globalThis.fetch = original; Date.now = now; }
});

test("absent manifest leaves legacy reader alone and mismatched entry fails closed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({}, 404);
  try { assert.equal(await load().lookupStandardWord("bank"), null); }
  finally { globalThis.fetch = original; }
  globalThis.fetch = async (url) => url.endsWith("current.json") ? manifest : entry("wrong-key");
  try { assert.deepEqual(await load().lookupStandardWord("bank"), { kind: "error" }); }
  finally { globalThis.fetch = original; }
});
