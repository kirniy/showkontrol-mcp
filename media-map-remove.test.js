import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,access,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {editMediaMappingsCopy} from './media-map-edit.js';
import {editMappingText} from './media-map-rows.js';
import {inspectShowMedia} from './media-inventory.js';
import {readShowSnapshot,readShowPart} from './xml-copy.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const MAP='/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n';
// Only c.wav is used by a clip; a.wav and b.wav are obsolete rows.
const track=(file='/orig/c.wav')=>`<sktimeline version="1" name="T"><layers><layer name="L"/></layers><audio name="Main" follow="1"><clip name="C" file="${file}" wave="" grid=""/></audio></sktimeline>`;
const programPart=file=>part('content/Program.skpr',`<skprogram version="1"><item start="0" name="Item" notes=""/><item start="1" name="Song" notes=""><sktimeline version="1"><audio name="P" follow="0"><clip name="P" file="${file}"/></audio></sktimeline></item></skprogram>`);

async function fixture(t,{map=MAP,parts='',timeline=track()}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-map-remove-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const xml=`<skshow>\n${map===null?'':part('media.map',map)}\n${part('content/T.sktl',timeline)}${part('patch.skf','<showkontrol version="2" name="Show"><graph/></showkontrol>')}${parts}</skshow>\n`;
 const source=path.join(dir,'a.skshow');await writeFile(source,xml);
 return {dir,source,xml,sha256:sha(xml),destination:path.join(dir,'b.skshow')};
}
const edit=(f,operations,extra={})=>editMediaMappingsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations,...extra});
const row=(line,sourcePath,archivePath)=>({line,sourcePath,archivePath});
const remove=(line,s,a)=>({action:'remove_mapping',...row(line,s,a)});
async function assertNothingPublished(f){
 await assert.rejects(access(f.destination));
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow']);
 assert.equal(await readFile(f.source,'utf8'),f.xml);
}

test('removes and re-points selected rows; other rows, parts and the wrapper keep their bytes',async t=>{
 const f=await fixture(t,{parts:part('MEDIA/a.wav','RIFF-a')+part('MEDIA/stray.wav','RIFF-s')});
 const r=await edit(f,[remove(1,'/orig/a.wav','MEDIA/a.wav'),{action:'repoint_mapping',...row(2,'/orig/b.wav','MEDIA/b.wav'),newSourcePath:'/lib/B take 2.wav',newArchivePath:'MEDIA/B take 2.wav'}]);
 assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,'/lib/B take 2.wav\tMEDIA/B take 2.wav\n/orig/c.wav\tMEDIA/c.wav\n');
 assert.equal(r.sha256,sha(await readFile(f.destination)));
 assert.deepEqual(r.operations,[
  {operationIndex:0,action:'remove_mapping',line:1,before:{sourcePath:'/orig/a.wav',archivePath:'MEDIA/a.wav'},after:null},
  {operationIndex:1,action:'repoint_mapping',line:2,before:{sourcePath:'/orig/b.wav',archivePath:'MEDIA/b.wav'},after:{line:1,sourcePath:'/lib/B take 2.wav',archivePath:'MEDIA/B take 2.wav'}},
 ]);
 assert.deepEqual(r.mediaMap,{rowsBefore:3,rowsAfter:2});
 // The archive part of the removed row is kept and reported, as is a part no row named before.
 assert.deepEqual(r.unmappedArchiveParts,[{name:'MEDIA/a.wav',valid:true,size:6,reason:'mapping_changed'},{name:'MEDIA/stray.wav',valid:true,size:6,reason:'unmapped_in_source'}]);
 const before=await readShowSnapshot({file:f.source}),after=await readShowSnapshot({file:f.destination});
 assert.deepEqual(after.parts.map(p=>p.name),before.parts.map(p=>p.name));
 for(const [i,p] of before.parts.entries())if(p.name!=='media.map')assert.ok(after.parts[i].bytes.equals(p.bytes),p.name);
 const strip=xml=>xml.replace(/<part name="media\.map"[^>]*>[^<]*<\/part>/,'');
 assert.equal(strip(await readFile(f.destination,'utf8')),strip(f.xml));
 // Independent read-back: the remaining clip still resolves to its row.
 const inventory=await inspectShowMedia({file:f.destination});
 assert.deepEqual(inventory.diagnostics,[]);
 assert.deepEqual(inventory.clips.map(c=>[c.attributes.file,c.mappingLines]),[['/orig/c.wav',[2]]]);
 assert.equal(await readFile(f.source,'utf8'),f.xml);
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow','b.skshow']);
});

test('keeps CRLF, mixed line breaks, a BOM and a missing final line break of untouched rows',async t=>{
 for(const [map,ops,expected] of [
  ['/a\tMEDIA/a\r\n/b\tMEDIA/b\r\n/c\tMEDIA/c',[remove(2,'/b','MEDIA/b')],'/a\tMEDIA/a\r\n/c\tMEDIA/c'],
  ['/a\tMEDIA/a\r\n/b\tMEDIA/b\n/c\tMEDIA/c\r\n',[remove(1,'/a','MEDIA/a')],'/b\tMEDIA/b\n/c\tMEDIA/c\r\n'],
  ['\ufeff/a\tMEDIA/a\n/b\tMEDIA/b',[remove(1,'/a','MEDIA/a')],'\ufeff/b\tMEDIA/b'],
  ['/a\tMEDIA/a\n/b\tMEDIA/b',[remove(2,'/b','MEDIA/b')],'/a\tMEDIA/a\n'],
  ['\ufeff/a\tMEDIA/a\r\n/b\tMEDIA/b',[{action:'repoint_mapping',...row(2,'/b','MEDIA/b'),newArchivePath:'MEDIA/z'}],'\ufeff/a\tMEDIA/a\r\n/b\tMEDIA/z'],
  ['/a\tMEDIA/a\n',[remove(1,'/a','MEDIA/a')],''],
  ['\ufeff/a\tMEDIA/a\r\n',[remove(1,'/a','MEDIA/a')],'\ufeff'],
 ]){
  const f=await fixture(t,{map});
  const r=await edit(f,ops);
  assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,expected,JSON.stringify(map));
  assert.deepEqual((await inspectShowMedia({file:f.destination})).diagnostics,[],JSON.stringify(map));
  assert.deepEqual(r.warnings.map(w=>w.code),expected.replace('\ufeff','')?[]:['media_map_empty']);
 }
 // The text editor alone: unselected lines are copied verbatim.
 assert.equal(editMappingText('/a\tx\r\n/b\ty\n',new Map([[2,{sourcePath:'/n',archivePath:'MEDIA/n'}]])),'/a\tx\r\n/n\tMEDIA/n\n');
});

test('selects rows only by line with both exact values and fails on any ambiguity',async t=>{
 const repoint=(line,s,a,extra)=>({action:'repoint_mapping',...row(line,s,a),...extra});
 const cases=[
  [{},[remove(4,'/orig/a.wav','MEDIA/a.wav')],/no mapping on line 4/],
  [{},[remove(2,'/orig/a.wav','MEDIA/a.wav')],/line 2 maps "\/orig\/b\.wav" to "MEDIA\/b\.wav", not "\/orig\/a\.wav"/],
  [{},[remove(1,'/orig/a.wav','MEDIA/A.wav')],/line 1 maps/],
  [{},[remove(1,'/orig/a.wav','MEDIA/a.wav'),remove(1,'/orig/a.wav','MEDIA/a.wav')],/already selected by mapping operation 0/],
  [{},[remove(0,'/orig/a.wav','MEDIA/a.wav')],/positive media\.map line/],
  [{},[{...remove(1,'/orig/a.wav','MEDIA/a.wav'),newSourcePath:'/x'}],/only their fields/],
  [{},[{action:'delete',...row(1,'/orig/a.wav','MEDIA/a.wav')}],/remove_mapping or repoint_mapping/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{})],/newSourcePath, newArchivePath or both/],
  // New values may not reuse any value of the inspected map, even one this call removes.
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newSourcePath:'/orig/c.wav'})],/source path of the inspected media\.map \(line 3\)/],
  [{},[remove(2,'/orig/b.wav','MEDIA/b.wav'),repoint(1,'/orig/a.wav','MEDIA/a.wav',{newSourcePath:'/orig/b.wav'})],/inspected media\.map \(line 2\)/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newArchivePath:'MEDIA/C.WAV'})],/collides with MEDIA\/c\.wav/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newArchivePath:'MEDIA/A.wav'})],/collides with MEDIA\/a\.wav/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newArchivePath:'MEDIA/n.wav'}),repoint(2,'/orig/b.wav','MEDIA/b.wav',{newArchivePath:'MEDIA/N.wav'})],/also introduced by mapping operation 0/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newSourcePath:'/n'}),repoint(2,'/orig/b.wav','MEDIA/b.wav',{newSourcePath:'/n'})],/also introduced by mapping operation 0/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newSourcePath:'rel/a.wav'})],/normalized absolute/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newSourcePath:'/x\ty'})],/normalized absolute/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newArchivePath:'MEDIA/sub/a.wav'})],/Sidecar name/],
  [{},[repoint(1,'/orig/a.wav','MEDIA/a.wav',{newArchivePath:'Other/a.wav'})],/directly in MEDIA/],
  [{map:'/x\tMEDIA/x\n/x\tMEDIA/y\n'},[remove(1,'/x','MEDIA/x')],/cannot be selected unambiguously: duplicate_source/],
  [{map:'bad\n/x\tMEDIA/x\n'},[remove(2,'/x','MEDIA/x')],/malformed_mapping/],
  [{map:null},[remove(1,'/x','MEDIA/x')],/exactly one media\.map/],
  [{parts:part('media.map','/x\tMEDIA/x\n')},[remove(1,'/orig/a.wav','MEDIA/a.wav')],/exactly one media\.map/],
  [{},[],/at least one mapping operation/],
 ];
 for(const [options,operations,error] of cases){
  const f=await fixture(t,options);
  await assert.rejects(edit(f,operations),error,JSON.stringify(operations).slice(0,160));
  await assertNothingPublished(f);
 }
 const f=await fixture(t);
 await assert.rejects(edit(f,[remove(1,'/orig/a.wav','MEDIA/a.wav')],{sha256:'0'.repeat(64)}),/Source changed since inspection/);
 await assert.rejects(edit(f,[remove(1,'/orig/a.wav','MEDIA/a.wav')],{destination:f.source}),/different absolute paths/);
 await assertNothingPublished(f);
});

test('refuses to orphan a value still named by a track or Program clip or by any other part',async t=>{
 const cases=[
  // Track clip file, reported by position.
  [{},[remove(3,'/orig/c.wav','MEDIA/c.wav')],/sourcePath "\/orig\/c\.wav" of media\.map line 3 referenced without a mapping: content\/T\.sktl audio 0 clip 0 file; part content\/T\.sktl.*\. This tool changes only media\.map: first re-point or remove those references in another copy \(for example with showkontrol_edit_timeline_audio_clip_copy\), or keep the row$/],
  [{},[{action:'repoint_mapping',...row(3,'/orig/c.wav','MEDIA/c.wav'),newSourcePath:'/lib/c.wav'}],/content\/T\.sktl audio 0 clip 0 file/],
  // Program item clip.
  [{parts:programPart('/orig/a.wav')},[remove(1,'/orig/a.wav','MEDIA/a.wav')],/content\/Program\.skpr item 1 audio 0 clip 0 file/],
  // A clip naming the sidecar path instead of the source path.
  [{timeline:track('MEDIA/b.wav')},[remove(2,'/orig/b.wav','MEDIA/b.wav')],/archivePath "MEDIA\/b\.wav" of media\.map line 2 .*content\/T\.sktl audio 0 clip 0 file/],
  // Unknown attributes and other parts, XML-escaped, URI-encoded, other normalization or case.
  [{map:'/orig/R&B.wav\tMEDIA/rb.wav\n',parts:part('Set.skls','<sksetlist><set note="/orig/R&amp;B.wav"/></sksetlist>')},[remove(1,'/orig/R&B.wav','MEDIA/rb.wav')],/part Set\.skls/],
  [{map:'/orig/My Song.wav\tMEDIA/s.wav\n',parts:part('settings.json','{"last":"file:///orig/My%20Song.wav"}')},[remove(1,'/orig/My Song.wav','MEDIA/s.wav')],/part settings\.json/],
  [{map:'/orig/Cafe\u0301.wav\tMEDIA/k.wav\n',parts:part('notes.txt','/orig/Caf\u00e9.wav')},[remove(1,'/orig/Cafe\u0301.wav','MEDIA/k.wav')],/part notes\.txt/],
  // macOS file URLs percent-encode the decomposed form.
  [{map:'/orig/Caf\u00e9.wav\tMEDIA/k.wav\n',parts:part('settings.json','{"u":"file:///orig/Cafe%CC%81.wav"}')},[remove(1,'/orig/Caf\u00e9.wav','MEDIA/k.wav')],/part settings\.json/],
  [{map:'/orig/R&B.wav\tMEDIA/rb.wav\n',parts:part('notes.txt','see /orig/R&amp;B.wav')},[remove(1,'/orig/R&B.wav','MEDIA/rb.wav')],/part notes\.txt/],
  [{parts:part('notes.txt','/ORIG/A.WAV')},[remove(1,'/orig/a.wav','MEDIA/a.wav')],/part notes\.txt/],
  [{timeline:track('/orig/c.wav').replace('wave=""','wave="MEDIA/a.wav"')},[remove(1,'/orig/a.wav','MEDIA/a.wav')],/clip 0 wave/],
  // A part that is not text cannot be checked.
  [{parts:part('blob.bin',Buffer.from([0xff,0xfe,0]))},[remove(1,'/orig/a.wav','MEDIA/a.wav')],/blob\.bin is not UTF-8 text/],
 ];
 for(const [options,operations,error] of cases){
  const f=await fixture(t,options);
  await assert.rejects(edit(f,operations),error,JSON.stringify(operations).slice(0,160));
  await assertNothingPublished(f);
 }
});

test('a value another row or the new row keeps is not a dangling reference',async t=>{
 // Re-pointing only the sidecar keeps the clip's source path mapped.
 let f=await fixture(t);
 let r=await edit(f,[{action:'repoint_mapping',...row(3,'/orig/c.wav','MEDIA/c.wav'),newArchivePath:'MEDIA/c-v2.wav'}]);
 assert.deepEqual(r.operations[0].after,{line:3,sourcePath:'/orig/c.wav',archivePath:'MEDIA/c-v2.wav'});
 // Two sources share a sidecar; a part names the sidecar, and the other row still maps it.
 f=await fixture(t,{map:'/orig/a.wav\tMEDIA/s.wav\n/orig/c.wav\tMEDIA/s.wav\n',parts:part('notes.txt','MEDIA/s.wav')});
 r=await edit(f,[remove(1,'/orig/a.wav','MEDIA/s.wav')]);
 assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,'/orig/c.wav\tMEDIA/s.wav\n');
 // MEDIA/ archive parts are payloads and are not searched for references.
 f=await fixture(t,{parts:part('MEDIA/c.wav','/orig/a.wav')});
 r=await edit(f,[remove(1,'/orig/a.wav','MEDIA/a.wav')]);
 assert.deepEqual(r.unmappedArchiveParts,[]);
});

test('a match continued by a path character is another file, not a reference',async t=>{
 const map='/Music/kick.wav\tMEDIA/kick.wav\n/Old/Music/kick.wav\tMEDIA/old-kick.wav\n';
 // Longer paths and the parent directory do not block the removal; the markup </audio> does not match a short path.
 const f=await fixture(t,{map,timeline:track('/Old/Music/kick.wav'),parts:part('notes.txt','/Music/kick.wav.bak /music/kick.wavs /Music')});
 const r=await edit(f,[remove(1,'/Music/kick.wav','MEDIA/kick.wav')]);
 assert.equal(r.mediaMap.rowsAfter,1);
 // XML markup is not searched: /audio would otherwise match </audio>.
 const markup=await fixture(t,{map:'/audio\tMEDIA/audio\n'});
 assert.equal((await edit(markup,[remove(1,'/audio','MEDIA/audio')])).mediaMap.rowsAfter,0);
 for(const text of ['file:///Music/kick.wav','["/Music/kick.wav"]','x=/Music/kick.wav;','<a>/Music/kick.wav</a>','/Music/kick.wav?t=1','dir//Music/kick.wav']){
  const g=await fixture(t,{map,timeline:track('/Old/Music/kick.wav'),parts:part('notes.txt',text)});
  await assert.rejects(edit(g,[remove(1,'/Music/kick.wav','MEDIA/kick.wav')]),/part notes\.txt/,text);
  await assertNothingPublished(g);
 }
});

test('an existing destination is kept and the staging directory is removed',async t=>{
 const f=await fixture(t);await writeFile(f.destination,'keep');
 // Fails at the hard-link publication, after the staged copy was written and verified.
 await assert.rejects(edit(f,[remove(1,'/orig/a.wav','MEDIA/a.wav')]),{code:'EEXIST'});
 assert.equal(await readFile(f.destination,'utf8'),'keep');
 assert.deepEqual((await readdir(f.dir)).sort(),['a.skshow','b.skshow']);
 assert.equal(await readFile(f.source,'utf8'),f.xml);
});

test('MCP removes and re-points rows and rejects unknown fields and actions',async t=>{
 const f=await fixture(t);
 const client=new Client({name:'map-remove-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const inspected=JSON.parse((await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file:f.source}})).content[0].text);
 assert.equal(inspected.sha256,f.sha256);
 const call=operations=>client.callTool({name:'showkontrol_edit_media_mappings_copy',arguments:{source:f.source,destination:f.destination,sha256:inspected.sha256,operations}});
 for(const bad of [[{...remove(1,'/orig/a.wav','MEDIA/a.wav'),newArchivePath:'MEDIA/x'}],[{action:'rename_mapping',...row(1,'/orig/a.wav','MEDIA/a.wav')}],[],[remove(3,'/orig/c.wav','MEDIA/c.wav')]]){
  const r=await call(bad);assert.equal(r.isError,true,JSON.stringify(bad));await assertNothingPublished(f);
 }
 const refused=await call([remove(3,'/orig/c.wav','MEDIA/c.wav')]);
 assert.match(refused.content[0].text,/content\/T\.sktl audio 0 clip 0 file/);
 const m=inspected.mappings;
 const r=await call([{action:'remove_mapping',line:m[0].line,sourcePath:m[0].sourcePath,archivePath:m[0].archivePath},{action:'repoint_mapping',line:m[1].line,sourcePath:m[1].sourcePath,archivePath:m[1].archivePath,newSourcePath:'/lib/b.wav'}]);
 assert.equal(r.isError,undefined,r.content?.[0]?.text);
 const data=JSON.parse(r.content[0].text);
 assert.deepEqual(data.operations.map(o=>[o.action,o.line,o.after?.line??null]),[['remove_mapping',1,null],['repoint_mapping',2,1]]);
 assert.match(data.note,/unverified/);
 assert.equal((await readShowPart({file:f.destination,name:'media.map'})).text,'/lib/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n');
 const tool=(await client.listTools()).tools.find(x=>x.name==='showkontrol_edit_media_mappings_copy');
 assert.equal(tool.annotations.destructiveHint,false);
});
