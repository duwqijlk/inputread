import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/dictionary-positions.ts',import.meta.url),'utf8');
function load(globals={}){const m={exports:{}};new Function('module','exports','require',...Object.keys(globals),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports,id=>id==='@/lib/books-base'?{booksUrl:p=>p}:{cleanCatalogRef:s=>/^(word-lists|public-books):[a-z0-9_-]+$/.test(s)?s:''},...Object.values(globals));return m.exports;}
const catalogId='word-lists:test';
function mappingResponse(entries=[],identity=catalogId){return new Response(JSON.stringify({schema:'oewn-position-mappings-v1',catalogId:identity,entries}));}
async function fixture(m){const p=await m.dictionaryPosition(['The 😀 bank.'],0,6,'bank');assert.ok(p);return {...p,positionKey:await m.positionKey(catalogId,p),senseId:'opaque-existing-id',lemma:'bank',release:'oewn-2025-test',reviewedAt:1};}

test('chapter fingerprints and codepoint coordinates separate repeated words, paragraphs and editions',async()=>{
 const m=load();const paragraphs=['A 😀 bank beside a bank.','A 😀 bank beside a bank.'];
 const first=await m.dictionaryPosition(paragraphs,0,4,'bank');const next=await m.dictionaryPosition(paragraphs,0,18,'bank');
 assert.ok(first);assert.ok(next);assert.notEqual(await m.positionKey(catalogId,first),await m.positionKey(catalogId,next));
 const repeated=await m.dictionaryPosition(paragraphs,1,4,'bank');assert.notEqual(await m.positionKey(catalogId,first),await m.positionKey(catalogId,repeated));
 const edition=await m.dictionaryPosition([...paragraphs,'A new paragraph'],0,4,'bank');assert.notEqual(first.chapterSha256,edition.chapterSha256);
 assert.equal(await m.dictionaryPosition(paragraphs,0,5,'bank'),null);
});

test('chapter hashing reuses the exact text array without altering paragraph hashes',async()=>{
 let digests=0;const m=load({crypto:{subtle:{digest(...args){digests++;return globalThis.crypto.subtle.digest(...args);}}}});
 const paragraphs=['A 😀 bank beside a bank.'];
 const first=await m.dictionaryPosition(paragraphs,0,4,'bank');
 const second=await m.dictionaryPosition(paragraphs,0,18,'bank');
 assert.equal(digests,3);assert.equal(first.chapterSha256,second.chapterSha256);assert.equal(first.paragraphSha256,second.paragraphSha256);
 await m.dictionaryPosition([...paragraphs],0,4,'bank');assert.equal(digests,5);
});

test('one shared mapping load serves concurrent warmers and choices while the position key hashes',async()=>{
 const row=await fixture(load());let requests=0;let hashes=0;let finishFetch;let finishHash;
 const m=load({
  fetch:()=>{requests++;return new Promise(resolve=>{finishFetch=resolve;});},
  crypto:{subtle:{digest(...args){hashes++;return new Promise(resolve=>{finishHash=()=>resolve(globalThis.crypto.subtle.digest(...args));});}}},
 });
 const a=m.mappedPosition(catalogId,row);const b=m.warmDictionaryMappings(catalogId);const c=m.warmDictionaryMappings(catalogId);
 assert.equal(requests,1);assert.equal(hashes,1,'the key hash starts before the mapping fetch finishes');
 finishFetch(mappingResponse([row]));finishHash();
 const [mapped]=await Promise.all([a,b,c]);assert.deepEqual(mapped,row);assert.equal(mapped.release,'oewn-2025-test');
 await m.warmDictionaryMappings(catalogId);assert.equal(requests,1);
});

test('one static mapping request per book regardless of choices; mismatches never borrow a meaning',async()=>{
 const m=load();const native=globalThis.fetch;let requests=0;const row=await fixture(m);
 globalThis.fetch=async()=>{requests++;return mappingResponse([row]);};
 try{const [a,b]=await Promise.all([m.mappedPosition(catalogId,row),m.mappedPosition(catalogId,row)]);assert.equal(a.senseId,'opaque-existing-id');assert.deepEqual(a,b);assert.equal(requests,1);
 const wrong={...row,offset:0};assert.equal(await m.mappedPosition(catalogId,wrong),null);assert.equal(requests,1);
 assert.equal(await m.mappedPosition('',row),null);await m.warmDictionaryMappings('');assert.equal(requests,1);
 }finally{globalThis.fetch=native;}
});

test('invalid concurrent warm and lookup loads reject only lookup, then permit one shared retry',async()=>{
 const m=load();const row=await fixture(m);let calls=0;let finish;
 const native=globalThis.fetch;globalThis.fetch=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 try{
  const warm=m.warmDictionaryMappings(catalogId);const lookup=assert.rejects(m.mappedPosition(catalogId,row),/Mapping identity mismatch/);
  finish(mappingResponse([], 'word-lists:wrong'));await Promise.all([warm,lookup]);assert.equal(calls,1);
  const retryWarm=m.warmDictionaryMappings(catalogId);const retryLookup=m.mappedPosition(catalogId,row);
  finish(mappingResponse([row]));await retryWarm;assert.deepEqual(await retryLookup,row);assert.equal(calls,2);
 }finally{globalThis.fetch=native;}
});

test('missing mapping is cached across concurrent and later warmers and lookups',async()=>{
 const m=load();const row=await fixture(m);let calls=0;const native=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;return new Response(null,{status:404});};
 try{
  const [,a,b]=await Promise.all([m.warmDictionaryMappings(catalogId),m.mappedPosition(catalogId,row),m.mappedPosition(catalogId,row)]);
  assert.equal(a,null);assert.equal(b,null);await m.warmDictionaryMappings(catalogId);assert.equal(await m.mappedPosition(catalogId,row),null);assert.equal(calls,1);
 }finally{globalThis.fetch=native;}
});

test('warm failures are bounded and retryable, without background retry or unhandled rejection',async()=>{
 for(const fail of [()=>{throw new Error('offline');},async()=>{throw new Error('offline');},async()=>new Response(null,{status:503})]){
  const m=load();const row=await fixture(m);let calls=0;const native=globalThis.fetch;
  globalThis.fetch=()=>{calls++;return fail();};
  try{
   await m.warmDictionaryMappings(catalogId);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
   globalThis.fetch=async()=>{calls++;return mappingResponse([row]);};
   assert.deepEqual(await m.mappedPosition(catalogId,row),row);assert.equal(calls,2);
  }finally{globalThis.fetch=native;}
 }
});

test('malformed keys never fall back to coordinates, and matching keys must retain exact coordinates',async()=>{
 const good=await fixture(load());
 for(const altered of [{positionKey:'not-a-hash'},{positionKey:'0'.repeat(64)},{surface:'Bank'},{offset:7},{chapterSha256:'0'.repeat(64)},{paragraphSha256:'0'.repeat(64)},{paragraphIndex:1}]){
  const m=load();const native=globalThis.fetch;globalThis.fetch=async()=>mappingResponse([{...good,...altered}]);
  try{
   if(altered.positionKey==='not-a-hash')await assert.rejects(m.mappedPosition(catalogId,good),/Invalid mapping row/);
   else assert.equal(await m.mappedPosition(catalogId,good),null);
  }finally{globalThis.fetch=native;}
 }
});

test('prewarming preserves identity, size, duplicate, row and match-credit validation',async()=>{
 const good=await fixture(load());
 const invalid=[
  ()=>new Response(JSON.stringify({schema:'other',catalogId,entries:[]})),
  ()=>mappingResponse([], 'public-books:test'),
  ()=>mappingResponse([good,good]),
  ()=>mappingResponse([{...good,release:'../release'}]),
  ()=>mappingResponse([{...good,reviewedAt:0}]),
  ()=>mappingResponse([{...good,matchedBy:['bad']}]),
  ()=>mappingResponse([{...good,matchedBy:['a'.repeat(12),'a'.repeat(12)]}]),
  ()=>new Response('{}',{headers:{'content-length':String(192*1024+1)}}),
  ()=>new Response(' '.repeat(192*1024+1)),
  ()=>new Response('é'.repeat(100*1024)),
 ];
 for(const response of invalid){
  const m=load();const native=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response();};
  try{
   await m.warmDictionaryMappings(catalogId);
   await assert.rejects(m.mappedPosition(catalogId,good));assert.equal(calls,2,'invalid prewarm is not cached as a missing mapping');
  }finally{globalThis.fetch=native;}
 }
});

test('reader initial standard warm is capped at 80 tokens and cancels before its timer',()=>{
 const reader=readFileSync(new URL('../src/components/reader.tsx',import.meta.url),'utf8');
 const start=reader.indexOf('  // Fetch the pronunciation shards');const end=reader.indexOf('  // Restore the saved reading position',start);
 const snippet=ts.transpileModule(reader.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let cleanup;let scheduled;let warmed;let spoken;let cancelled=false;
 new Function('useEffect','linkedHtml','articleRef','window','warmIpaFor','warmStandardDictionary','TAP_WORD_PATTERN',snippet)(
  effect=>{cleanup=effect();},'chapter',{current:{textContent:Array.from({length:1000},(_,i)=>`word${i}`).join(' ')}},
  {setTimeout(callback,delay){assert.equal(delay,50);scheduled=callback;return 1;},clearTimeout(id){assert.equal(id,1);cancelled=true;}},
  text=>{spoken=text;},words=>{warmed=words;return Promise.resolve();},'[a-z]+[0-9]+',
 );
 assert.equal(warmed,undefined);scheduled();assert.equal(warmed.length,80);assert.equal(warmed[79],'word79');assert.ok(spoken.endsWith('word999'));
 cleanup();assert.equal(cancelled,true);
});

test('reader reuses exact rendered paragraph array until root, text, chapter or segmentation changes',async()=>{
 const reader=readFileSync(new URL('../src/components/reader.tsx',import.meta.url),'utf8');
 // Exercise the reader's actual cache and invalidation hook without mounting its unrelated services.
 const start=reader.indexOf('  const positionChapter = useRef<');const end=reader.indexOf('\n  const bookKey',start);
 assert.ok(start>0&&end>start);
 const snippet=ts.transpileModule(reader.slice(start,end)+'\nreturn renderedPositionChapter;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const dom=new JSDOM('<article><p>A 😀 bank.</p><p>The bank.</p></article>');
 const root=dom.window.document.querySelector('article');const articleRef={current:root};const cache={current:null};let dependencies;let walks=0;
 const blocks=r=>Array.from(r.querySelectorAll('p'));
 const flowSource=readFileSync(new URL('../src/lib/flow-text.ts',import.meta.url),'utf8');
 const flowModule={exports:{}};new Function('module','exports',ts.transpileModule(flowSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(flowModule,flowModule.exports);
 function render({html='original',key='book|1',paragraphs,segmentation=1}={}){
  return new Function('useRef','useLayoutEffect','linkedHtml','chapterKey','activeExtra','chapter','book','articleRef','readerParagraphBlocks','flowText',snippet)(
   ()=>cache,(effect,deps)=>{if(!dependencies||deps.some((value,i)=>value!==dependencies[i]))effect();dependencies=deps;},
   html,key,null,{paragraphs},{segmentation},articleRef,blocks,el=>{walks++;return flowModule.exports.flowText(el);},
  );
 }
 const get=render();const first=get();assert.deepEqual(first.texts,['A 😀 bank.','The bank.']);assert.equal(walks,2);
 assert.equal(get().texts,first.texts);assert.equal(render()().texts,first.texts);assert.equal(walks,2);
 root.querySelector('p').classList.add('book-on');const mark=dom.window.document.createElement('span');mark.dataset.paraUi='';root.querySelector('p').append(mark);
 assert.equal(render()().texts,first.texts);assert.equal(walks,2);
 root.innerHTML='<p>Another bank.</p>';const changed=render({html:'replacement'})();assert.deepEqual(changed.texts,['Another bank.']);assert.notEqual(changed.texts,first.texts);
 assert.notEqual(render({html:'replacement',key:'book|2'})().texts,changed.texts);
 const beforeSegmentation=cache.current.texts;assert.notEqual(render({html:'replacement',key:'book|2',segmentation:2})().texts,beforeSegmentation);
 articleRef.current=root.cloneNode(true);const beforeRoot=cache.current.texts;assert.notEqual(render({html:'replacement',key:'book|2',segmentation:2})().texts,beforeRoot);
 const plain=['First plain paragraph'];articleRef.current.innerHTML='<p>First plain paragraph</p>';const plainFirst=render({html:'',paragraphs:plain})();
 assert.equal(render({html:'',paragraphs:plain})().texts,plainFirst.texts);
 articleRef.current.innerHTML='<p>New plain paragraph</p>';const plainNext=render({html:'',paragraphs:['New plain paragraph']})();assert.deepEqual(plainNext.texts,['New plain paragraph']);assert.notEqual(plainNext.texts,plainFirst.texts);
 assert.match(reader,/positionParagraphs: positionChapter\?\.texts \?\? \[\]/);
 dom.window.close();
});

test('cross-edition paragraph fingerprint fallback matches shifted chapter and fails closed on ambiguous twins',async()=>{
 const m=load();const row=await fixture(m);
 const shiftedChapter=['Editor note added in another edition.','The 😀 bank.'];
 const shiftedPos=await m.dictionaryPosition(shiftedChapter,1,6,'bank');
 assert.ok(shiftedPos);assert.notEqual(shiftedPos.chapterSha256,row.chapterSha256);
 const native=globalThis.fetch;
 try{
  globalThis.fetch=async()=>mappingResponse([row]);
  const hit=await m.mappedPosition(catalogId,shiftedPos);
  assert.deepEqual(hit,row);

  // Two identical paragraphs in canonical chapter with the SAME senseId resolve to nearest paragraphIndex.
  const twinChapters=['The 😀 bank.','The 😀 bank.'];
  const p0=await m.dictionaryPosition(twinChapters,0,6,'bank');
  const p1=await m.dictionaryPosition(twinChapters,1,6,'bank');
  const r0={...p0,positionKey:await m.positionKey(catalogId,p0),senseId:'opaque-existing-id',lemma:'bank',release:'oewn-2025-test',reviewedAt:1};
  const r1={...p1,positionKey:await m.positionKey(catalogId,p1),senseId:'opaque-existing-id',lemma:'bank',release:'oewn-2025-test',reviewedAt:1};
  const mSame=load();
  globalThis.fetch=async()=>mappingResponse([r0,r1]);
  const sameHit=await mSame.mappedPosition(catalogId,shiftedPos);
  assert.equal(sameHit?.paragraphIndex,1);

  // Two identical paragraphs with DIFFERENT senseIds fail closed instead of guessing.
  const mConflict=load();
  globalThis.fetch=async()=>mappingResponse([r0,{...r1,senseId:'other-sense-id'}]);
  assert.equal(await mConflict.mappedPosition(catalogId,shiftedPos),null);

  // Forged positionKey on a different chapterSha256 row still fails closed.
  const mTampered=load();
  globalThis.fetch=async()=>mappingResponse([{...row,positionKey:'f'.repeat(64)}]);
  assert.equal(await mTampered.mappedPosition(catalogId,shiftedPos),null);
 }finally{globalThis.fetch=native;}
});

