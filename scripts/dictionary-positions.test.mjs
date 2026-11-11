import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/dictionary-positions.ts',import.meta.url),'utf8');
function load(){const m={exports:{}};new Function('module','exports','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports,id=>id==='@/lib/books-base'?{booksUrl:p=>p}:{cleanCatalogRef:s=>/^(word-lists|public-books):[a-z0-9_-]+$/.test(s)?s:''});return m.exports;}
test('chapter fingerprints and codepoint coordinates separate repeated words, paragraphs and editions',async()=>{
 const m=load();const paragraphs=['A 😀 bank beside a bank.','A 😀 bank beside a bank.'];
 const first=await m.dictionaryPosition(paragraphs,0,4,'bank');const next=await m.dictionaryPosition(paragraphs,0,18,'bank');
 assert.ok(first);assert.ok(next);assert.notEqual(await m.positionKey('word-lists:test',first),await m.positionKey('word-lists:test',next));
 const repeated=await m.dictionaryPosition(paragraphs,1,4,'bank');assert.notEqual(await m.positionKey('word-lists:test',first),await m.positionKey('word-lists:test',repeated));
 const edition=await m.dictionaryPosition([...paragraphs,'A new paragraph'],0,4,'bank');assert.notEqual(first.chapterSha256,edition.chapterSha256);
 assert.equal(await m.dictionaryPosition(paragraphs,0,5,'bank'),null);
});
test('one static mapping request per book regardless of choices; mismatches never borrow a meaning',async()=>{
 const m=load();const native=globalThis.fetch;let requests=0;const p=await m.dictionaryPosition(['The bank.'],0,4,'bank');const key=await m.positionKey('word-lists:test',p);
 globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({schema:'oewn-position-mappings-v1',catalogId:'word-lists:test',entries:[{...p,positionKey:key,senseId:'opaque-existing-id',lemma:'bank',release:'oewn-2025-test',reviewedAt:1}]}));};
 try{const [a,b]=await Promise.all([m.mappedPosition('word-lists:test',p),m.mappedPosition('word-lists:test',p)]);assert.equal(a.senseId,'opaque-existing-id');assert.deepEqual(a,b);assert.equal(requests,1);
 const wrong={...p,offset:0};assert.equal(await m.mappedPosition('word-lists:test',wrong),null);assert.equal(requests,1);
 assert.equal(await m.mappedPosition('',p),null);assert.equal(requests,1);
 }finally{globalThis.fetch=native;}
});
test('invalid source mapping is rejected and can be retried; missing mapping remains cached',async()=>{
 const native=globalThis.fetch;const m=load();const p=await m.dictionaryPosition(['bank'],0,0,'bank');let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({schema:'oewn-position-mappings-v1',catalogId:'wrong',entries:[]}));};
 try{await assert.rejects(m.mappedPosition('word-lists:test',p));globalThis.fetch=async()=>{calls++;return new Response('',{status:404});};assert.equal(await m.mappedPosition('word-lists:test',p),null);assert.equal(await m.mappedPosition('word-lists:test',p),null);assert.equal(calls,2);}finally{globalThis.fetch=native;}
});
