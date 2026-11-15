import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,access,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {addMediaMappingsCopy} from './media-map-edit.js';
import {inspectShowMedia} from './media-inventory.js';
import {readShowSnapshot,readShowPart} from './xml-copy.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const timeline='<sktimeline version="1"><audio><clip file="/lib/new.wav" name="New"/><clip file="/orig/old.wav" name="Old"/></audio></sktimeline>';
const opaque=Buffer.from([0,1,2,255,254]);

async function fixture(t,{map='/orig/old.wav\tMEDIA/old.wav\n',parts=''}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-map-edit-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const xml=`<skshow>\n${map===null?'':part('media.map',map)}\n${part('content/A.sktl',timeline)}${part('blob.bin',opaque)}${parts}</skshow>\n`;
 const source=path.join(dir,'a.skshow');await writeFile(source,xml);
 return {dir,source,xml,sha256:sha(xml),destination:path.join(dir,'b.skshow')};
}
const add=(f,mappings,extra={})=>addMediaMappingsCopy({source:f.source,destination:f.destination,sha256:f.sha256,mappings,...extra});
async function assertNothingPublished(f){
 await assert.rejects(access(f.destination));
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow']);
 assert.equal(await readFile(f.source,'utf8'),f.xml);
}

test('appends rows after the existing ones and keeps every other part and the wrapper',async t=>{
 const f=await fixture(t,{parts:part('MEDIA/new.wav','RIFF')});
 const r=await add(f,[{sourcePath:'/lib/new.wav',archivePath:'MEDIA/new.wav'},{sourcePath:'/lib/Second Take.wav',archivePath:'MEDIA/Second Take.wav'}]);
 assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,'/orig/old.wav\tMEDIA/old.wav\n/lib/new.wav\tMEDIA/new.wav\n/lib/Second Take.wav\tMEDIA/Second Take.wav\n');
 assert.equal(r.sha256,sha(await readFile(f.destination)));
 assert.deepEqual(r.mappings.map(({line,sourcePath,archivePath})=>[line,sourcePath,archivePath]),[[2,'/lib/new.wav','MEDIA/new.wav'],[3,'/lib/Second Take.wav','MEDIA/Second Take.wav']]);
 // The first row has a matching archive part and a clip that names it; the second has neither.
 assert.deepEqual(r.mappings[0].archiveParts,[{name:'MEDIA/new.wav',valid:true,size:4}]);
 assert.deepEqual(r.mappings[0].clips,[{part:'content/A.sktl',audioIndex:0,clipIndex:0}]);
 assert.deepEqual([r.mappings[1].archiveParts,r.mappings[1].clips],[[],[]]);
 const before=await readShowSnapshot({file:f.source}),after=await readShowSnapshot({file:f.destination});
 assert.deepEqual(after.parts.map(p=>p.name),before.parts.map(p=>p.name));
 for(const [i,p] of before.parts.entries())if(p.name!=='media.map')assert.ok(after.parts[i].bytes.equals(p.bytes),p.name);
 // Only the media.map part element changed; the wrapper text around the parts is unchanged.
 const strip=xml=>xml.replace(/<part name="media\.map"[^>]*>[^<]*<\/part>/,'');
 assert.equal(strip(await readFile(f.destination,'utf8')),strip(f.xml));
 assert.equal(await readFile(f.source,'utf8'),f.xml);
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow','b.skshow']);
 assert.equal((await inspectShowMedia({file:f.destination})).diagnostics.length,0);
});

test('keeps CRLF line endings, a BOM and a missing final line break parseable',async t=>{
 for(const [map,expected] of [
  ['/orig/old.wav\tMEDIA/old.wav\r\n','/orig/old.wav\tMEDIA/old.wav\r\n/lib/new.wav\tMEDIA/new.wav\r\n'],
  ['/orig/old.wav\tMEDIA/old.wav','/orig/old.wav\tMEDIA/old.wav\n/lib/new.wav\tMEDIA/new.wav\n'],
  ['\ufeff','\ufeff/lib/new.wav\tMEDIA/new.wav\n'],
  ['','/lib/new.wav\tMEDIA/new.wav\n'],
 ]){
  const f=await fixture(t,{map});
  await add(f,[{sourcePath:'/lib/new.wav',archivePath:'MEDIA/new.wav'}]);
  assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,expected,JSON.stringify(map));
  const inventory=await inspectShowMedia({file:f.destination});
  assert.deepEqual(inventory.diagnostics,[],JSON.stringify(map));
  assert.deepEqual(inventory.mappings.at(-1).sourcePath,'/lib/new.wav');
 }
});

test('an existing duplicate sidecar row is tolerated as in session media copies',async t=>{
 const f=await fixture(t,{map:'/orig/old.wav\tMEDIA/old.wav\n/orig/alias.wav\tMEDIA/old.wav\n'});
 const r=await add(f,[{sourcePath:'/lib/new.wav',archivePath:'MEDIA/new.wav'}]);
 assert.equal(r.mappings[0].line,3);
});

test('rejects unsafe rows and ambiguous maps and publishes nothing',async t=>{
 const cases=[
  [{},[{sourcePath:'/orig/old.wav',archivePath:'MEDIA/other.wav'}],/already mapped on media.map line 1/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'},{sourcePath:'/lib/a.wav',archivePath:'MEDIA/b.wav'}],/already mapped in this call/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/OLD.wav'}],/collides with mapped MEDIA\/old\.wav/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'},{sourcePath:'/lib/b.wav',archivePath:'MEDIA/A.WAV'}],/collides with mapped MEDIA\/a\.wav/],
  [{map:'/orig/x\tMEDIA/Cafe\u0301.wav\n'},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/CAF\u00c9.wav'}],/collides/],
  [{map:'/orig/x\tMEDIA/dir/x.wav\n'},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/DIR'}],/collides with mapped MEDIA\/dir\/x\.wav/],
  [{},[{sourcePath:'lib/a.wav',archivePath:'MEDIA/a.wav'}],/normalized absolute/],
  [{},[{sourcePath:'/lib/../a.wav',archivePath:'MEDIA/a.wav'}],/normalized absolute/],
  [{},[{sourcePath:'/lib/a\tb.wav',archivePath:'MEDIA/a.wav'}],/normalized absolute/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/sub/a.wav'}],/Sidecar name/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/.hidden'}],/Sidecar name/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a\nb.wav'}],/Sidecar name/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'Other/a.wav'}],/directly in MEDIA/],
  [{},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav',extra:1}],/Invalid mapping at index 0/],
  [{},[],/1 to 100/],
  [{},Array.from({length:101},(_,i)=>({sourcePath:`/lib/${i}.wav`,archivePath:`MEDIA/${i}.wav`})),/1 to 100/],
  [{map:null},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],/exactly one media\.map/],
  [{parts:part('media.map','/x\tMEDIA/x\n')},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],/exactly one media\.map/],
  [{map:'bad line\n'},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],/cannot be extended safely: malformed_mapping/],
  [{map:'/x\tMEDIA/x\n/x\tMEDIA/y\n'},[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],/cannot be extended safely: duplicate_source/],
 ];
 for(const [options,mappings,error] of cases){
  const f=await fixture(t,options);
  await assert.rejects(add(f,mappings),error,JSON.stringify(mappings).slice(0,120));
  await assertNothingPublished(f);
 }
 const f=await fixture(t);
 await assert.rejects(add(f,[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],{sha256:'0'.repeat(64)}),/Source changed since inspection/);
 await assertNothingPublished(f);
 await assert.rejects(add(f,[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],{destination:f.source}),/different absolute paths/);
 await assert.rejects(add(f,[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}],{destination:'b.skshow'}),/different absolute paths/);
 await assertNothingPublished(f);
});

test('an existing destination is kept and the staging directory is removed',async t=>{
 const f=await fixture(t);await writeFile(f.destination,'keep');
 await assert.rejects(add(f,[{sourcePath:'/lib/a.wav',archivePath:'MEDIA/a.wav'}]),{code:'EEXIST'});
 assert.equal(await readFile(f.destination,'utf8'),'keep');
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow','b.skshow']);
});

test('MCP appends rows and rejects unknown mapping fields',async t=>{
 const f=await fixture(t);
 const client=new Client({name:'map-edit-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_add_media_mappings_copy',arguments:{source:f.source,destination:f.destination,sha256:f.sha256,...args}});
 let r=await call({mappings:[{sourcePath:'/lib/new.wav',archivePath:'MEDIA/new.wav',file:'x'}]});
 assert.equal(r.isError,true);await assertNothingPublished(f);
 r=await call({mappings:[{sourcePath:'/lib/new.wav',archivePath:'MEDIA/new.wav'}]});
 assert.equal(r.isError,undefined,r.content?.[0]?.text);
 const data=JSON.parse(r.content[0].text);
 assert.deepEqual(data.mappings.map(m=>[m.line,m.archivePath,m.clips.length]),[[2,'MEDIA/new.wav',1]]);
 assert.match(data.note,/No media file is read or copied/);
 assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,'/orig/old.wav\tMEDIA/old.wav\n/lib/new.wav\tMEDIA/new.wav\n');
});
