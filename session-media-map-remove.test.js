import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath,symlink,unlink} from 'node:fs/promises';
import {watch} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {inspectShowMedia} from './media-inventory.js';
import {readShowPart} from './xml-copy.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const fields='pps="315" offsetMs="0" trimStartMs="0" trimEndMs="1000" fadeInMs="0" fadeOutMs="0"';
const patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';
const timeline=`<sktimeline version="1" name="A"><layers><layer name="L"/></layers><audio name="Main" follow="1"><clip name="A" file="/orig/a.wav" wave="" grid="" ${fields}/></audio><deck/></sktimeline>`;
const program='<skprogram version="1"><item start="0" name="Song" notes=""><sktimeline version="1"><audio name="P" follow="0"><clip name="C" file="/orig/c.wav"/></audio></sktimeline></item></skprogram>';
const MAP='/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n';

// a.wav is used by a track clip, c.wav by a Program item clip, b.wav by nothing; MEDIA/stray.wav has no row.
async function session(t,{map=MAP,big=false}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-session-map-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'Session A'),library=path.join(dir,'library');
 await mkdir(path.join(root,'MEDIA'),{recursive:true});await mkdir(path.join(root,'TIMELINE'));await mkdir(library);
 const media=path.join(library,'new.wav');await writeFile(media,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(2048,5)]));
 if(typeof map==='function')map=map(media);
 const show=`<skshow>${part('media.map',map)}${part('content/A.sktl',timeline)}${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 await writeFile(path.join(root,'session.skshow'),show);
 await writeFile(path.join(root,'TIMELINE','A.sktl'),timeline);
 await writeFile(path.join(root,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 await writeFile(path.join(root,'settings.json'),'{"lastPlayer":"internal"}\n');
 await writeFile(path.join(root,'MEDIA','a.wav'),big?Buffer.alloc(32*1024*1024,1):'RIFF-a');
 for(const name of ['b','c','stray'])await writeFile(path.join(root,'MEDIA',`${name}.wav`),`RIFF-${name}`);
 return {dir,root,media,sha256:sha(show),destination:path.join(dir,'Session B')};
}
async function tree(root){
 const out={};
 for(const entry of await readdir(root,{withFileTypes:true,recursive:true})){const file=path.join(entry.parentPath??entry.path,entry.name);out[path.relative(root,file)]=entry.isFile()?sha(await readFile(file)):'dir';}
 return out;
}
const temps=async dir=>(await readdir(dir)).filter(n=>n.startsWith('.showkontrol'));
async function assertNothingPublished(s,before){
 await assert.rejects(access(s.destination));
 assert.deepEqual(await temps(s.dir),[]);
 assert.deepEqual(await tree(s.root),before);
}
const remove=(line,name)=>({action:'remove_mapping',line,sourcePath:`/orig/${name}.wav`,archivePath:`MEDIA/${name}.wav`});
const compose=(s,args)=>composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,...args});
const mapText=async r=>(await readShowPart({file:r.sessionFile,name:'media.map'})).text;

test('removes an obsolete row and leaves out or keeps its sidecar as asked',async t=>{
 let s=await session(t);const before=await tree(s.root);
 await assert.rejects(compose(s,{mediaMapOperations:[remove(2,'b')]}),/leave MEDIA\/b\.wav without a media\.map row; set removedSidecars/);
 await assertNothingPublished(s,before);
 let r=await compose(s,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'});
 assert.deepEqual(await tree(s.root),before);
 assert.equal(await mapText(r),'/orig/a.wav\tMEDIA/a.wav\n/orig/c.wav\tMEDIA/c.wav\n');
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['a.wav','c.wav','stray.wav']);
 assert.deepEqual(r.mediaMap.operations,[{operationIndex:0,action:'remove_mapping',line:2,before:{sourcePath:'/orig/b.wav',archivePath:'MEDIA/b.wav'},after:null,oldSidecar:'omitted'}]);
 assert.equal(r.mediaMap.preservedRows,2);
 assert.deepEqual(r.mediaMap.unmappedSidecars,[{path:'MEDIA/stray.wav',size:10,action:'kept',reason:'unmapped_in_source'},{path:'MEDIA/b.wav',size:6,action:'omitted',reason:'mapping_released',lines:[2]}]);
 assert.deepEqual(r.sidecars.map(x=>[x.archivePath,x.lines]),[['MEDIA/a.wav',[1]],['MEDIA/c.wav',[2]]]);
 // Independent read-back of the published session.
 let after=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(after.findings.map(x=>[x.line,x.archivePath,x.status]),[[1,'MEDIA/a.wav','regular_file'],[2,'MEDIA/c.wav','regular_file']]);
 assert.deepEqual(after.clips.map(c=>[c.itemIndex??null,c.mapping]),[[null,{line:1,archivePath:'MEDIA/a.wav',sidecar:'regular_file'}],[0,{line:2,archivePath:'MEDIA/c.wav',sidecar:'regular_file'}]]);
 assert.deepEqual(after.unmappedMediaEntries,[{path:'MEDIA/stray.wav',kind:'regular_file',size:10}]);
 assert.deepEqual(after.diagnostics,[]);
 // Unchanged parts keep their working files verbatim.
 assert.equal(await readFile(path.join(s.destination,'TIMELINE','A.sktl'),'utf8'),timeline);

 // A released sidecar must be a regular file or missing, even when unverified working files may be omitted.
 const linked=await session(t);await unlink(path.join(linked.root,'MEDIA','b.wav'));await symlink(path.join(linked.dir,'library','new.wav'),path.join(linked.root,'MEDIA','b.wav'));
 const linkedTree=await tree(linked.root);
 await assert.rejects(compose(linked,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit',omitUnverifiedWorkingFiles:true}),/Sidecar MEDIA\/b\.wav of media\.map line 2 is symlink/);
 await assertNothingPublished(linked,linkedTree);
 // A missing released sidecar needs no removedSidecars choice.
 const gone=await session(t);await unlink(path.join(gone.root,'MEDIA','b.wav'));
 assert.equal((await compose(gone,{mediaMapOperations:[remove(2,'b')]})).mediaMap.operations[0].oldSidecar,'missing');

 s=await session(t);
 r=await compose(s,{mediaMapOperations:[remove(2,'b')],removedSidecars:'keep'});
 assert.equal(r.mediaMap.operations[0].oldSidecar,'kept');
 assert.equal(await readFile(path.join(s.destination,'MEDIA','b.wav'),'utf8'),'RIFF-b');
 assert.deepEqual(r.mediaMap.unmappedSidecars.map(x=>[x.path,x.action,x.reason]),[['MEDIA/b.wav','kept','mapping_released'],['MEDIA/stray.wav','kept','unmapped_in_source']]);
 after=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(after.unmappedMediaEntries.map(x=>x.path),['MEDIA/b.wav','MEDIA/stray.wav']);
});

test('one call re-points a clip to new media and removes the row it no longer needs',async t=>{
 const s=await session(t),before=await tree(s.root);
 const r=await compose(s,{media:[{source:s.media}],tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{name:'A new'}}]}],mediaMapOperations:[remove(1,'a')],removedSidecars:'omit'});
 assert.deepEqual(await tree(s.root),before);
 assert.equal(await mapText(r),`/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n${s.media}\tMEDIA/new.wav\n`);
 assert.deepEqual(r.mediaMap.addedRows,[{mediaIndex:0,line:3,sourcePath:s.media,archivePath:'MEDIA/new.wav'}]);
 assert.deepEqual(r.clipLinks,[{trackIndex:0,clipEditIndex:0,file:s.media,mappingLine:3,archivePath:'MEDIA/new.wav',sidecar:'copied'}]);
 // The removed row is not reported as unreferenced; the old extraction is rewritten, not searched.
 assert.deepEqual(r.warnings.map(w=>w.code),['working_patch_root_name_is_session_name']);
 assert.deepEqual(r.workingFiles.entries.filter(e=>e.action!=='copied').map(e=>[e.path,e.action]),[['TIMELINE/A.sktl','regenerated']]);
 assert.equal(r.validation.diagnostics.filter(d=>d.severity==='error').length,0);
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['b.wav','c.wav','new.wav','stray.wav']);
 const inventory=await inspectShowMedia({file:r.sessionFile});
 assert.deepEqual(inventory.clips.map(c=>[c.attributes.file,c.mappingLines]),[[s.media,[3]],['/orig/c.wav',[2]]]);
 assert.deepEqual(inventory.diagnostics,[]);
});

test('refuses a removal while the composed archive or a carried working file still names the value',async t=>{
 const s=await session(t),before=await tree(s.root);
 for(const [args,pattern] of [
  [{mediaMapOperations:[remove(1,'a')]},/sourcePath "\/orig\/a\.wav" of media\.map line 1 referenced without a mapping: content\/A\.sktl audio 0 clip 0 file.*\. Re-point or remove the references in the same composition, or keep the row$/],
  [{mediaMapOperations:[remove(3,'c')]},/content\/Program\.skpr item 0 audio 0 clip 0 file/],
  [{mediaMapOperations:[{action:'repoint_mapping',line:1,sourcePath:'/orig/a.wav',archivePath:'MEDIA/a.wav',newSourcePath:'/lib/a.wav'}]},/content\/A\.sktl audio 0 clip 0 file/],
  // A clip edit that keeps the old file does not help.
  [{tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,attributes:{name:'Renamed'}}]}],mediaMapOperations:[remove(1,'a')]},/content\/A\.sktl audio 0 clip 0 file/],
 ]){
  await assert.rejects(compose(s,{removedSidecars:'omit',...args}),pattern);
  await assertNothingPublished(s,before);
 }
 // Working files outside MEDIA/ are searched as text, or as bytes when they are not UTF-8.
 for(const [rel,value,pattern] of [
  ['settings.json','{"recent":["/orig/b.wav"]}\n',/working file settings\.json$|working file settings\.json\./],
  ['.DS_Store',Buffer.concat([Buffer.from([0,0,0xff]),Buffer.from('/orig/b.wav'),Buffer.from([0xfe])]),/working file \.DS_Store \(bytes\)/],
  // macOS .DS_Store records store names as UTF-16BE.
  ['.DS_Store',Buffer.concat([Buffer.from('Bud1'),Buffer.from('/orig/b.wav','utf16le').swap16()]),/working file \.DS_Store \(UTF-16\)/],
  ['notes/MEDIA-b.txt','MEDIA/b.wav',/archivePath "MEDIA\/b\.wav".*working file notes\/MEDIA-b\.txt/],
 ]){
  const w=await session(t),prior=await tree(w.root);
  await mkdir(path.dirname(path.join(w.root,rel)),{recursive:true});await writeFile(path.join(w.root,rel),value);
  const withFile=await tree(w.root);assert.notDeepEqual(withFile,prior);
  await assert.rejects(compose(w,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'}),pattern);
  await assertNothingPublished(w,withFile);
 }
 // An extraction of media.map is the edited map itself; a kept row naming MEDIA/b.wav inside a longer path does not block.
 const x=await session(t,{map:'/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n/s/MEDIA/b.wav\tMEDIA/x.wav\n'});
 await writeFile(path.join(x.root,'MEDIA','x.wav'),'RIFF-x');
 await writeFile(path.join(x.root,'media.map'),'/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n/s/MEDIA/b.wav\tMEDIA/x.wav\n');
 const extracted=await compose(x,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'});
 assert.deepEqual(extracted.workingFiles.entries.filter(e=>e.path==='media.map').map(e=>e.action),['regenerated']);
 assert.equal(await readFile(path.join(x.destination,'media.map'),'utf8'),await mapText(extracted));
 // Files below MEDIA/ are media payloads and are not searched.
 const m=await session(t);await writeFile(path.join(m.root,'MEDIA','stray.wav'),'/orig/b.wav');
 await compose(m,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'});
});

test('re-points a sidecar name by copying the sidecar and a source path together with its clips',async t=>{
 let s=await session(t);const before=await tree(s.root);
 let r=await compose(s,{mediaMapOperations:[{action:'repoint_mapping',line:3,sourcePath:'/orig/c.wav',archivePath:'MEDIA/c.wav',newArchivePath:'MEDIA/C final.wav'}],removedSidecars:'omit'});
 assert.deepEqual(await tree(s.root),before);
 assert.equal(await mapText(r),'/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/C final.wav\n');
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['C final.wav','a.wav','b.wav','stray.wav']);
 assert.equal(await readFile(path.join(s.destination,'MEDIA','C final.wav'),'utf8'),'RIFF-c');
 const renamed=r.sidecars.find(x=>x.archivePath==='MEDIA/C final.wav');
 assert.deepEqual([renamed.renamedFrom,renamed.lines,renamed.sha256],['MEDIA/c.wav',[3],sha('RIFF-c')]);
 assert.deepEqual(r.mediaMap.operations[0].after,{line:3,sourcePath:'/orig/c.wav',archivePath:'MEDIA/C final.wav'});
 const after=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(after.clips.find(c=>c.itemIndex===0).mapping,{line:3,archivePath:'MEDIA/C final.wav',sidecar:'regular_file'});
 // A new sidecar name may not take an existing session entry.
 s=await session(t);
 await assert.rejects(compose(s,{mediaMapOperations:[{action:'repoint_mapping',line:3,sourcePath:'/orig/c.wav',archivePath:'MEDIA/c.wav',newArchivePath:'MEDIA/STRAY.wav'}],removedSidecars:'omit'}),/collides with existing session entry MEDIA\/stray\.wav.*newArchivePath/);
 // A source path re-pointed with every clip that names it; the sidecar stays mapped.
 r=await compose(s,{tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,attributes:{file:'/lib/a.wav'}}]}],mediaMapOperations:[{action:'repoint_mapping',line:1,sourcePath:'/orig/a.wav',archivePath:'MEDIA/a.wav',newSourcePath:'/lib/a.wav'}]});
 assert.equal(r.mediaMap.operations[0].oldSidecar,'still_mapped');
 assert.equal(await mapText(r),'/lib/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n');
 assert.deepEqual(r.clipLinks,[{trackIndex:0,clipEditIndex:0,file:'/lib/a.wav',mappingLine:1,archivePath:'MEDIA/a.wav',sidecar:'copied'}]);
});

test('new media may reuse a released name only when its sidecar is left out',async t=>{
 let s=await session(t);const before=await tree(s.root);
 const args={media:[{source:s.media,sidecarName:'b.wav'}],mediaMapOperations:[remove(2,'b')]};
 await assert.rejects(compose(s,{...args,removedSidecars:'keep'}),/collides with existing session entry MEDIA\/b\.wav.*sidecarName/);
 await assertNothingPublished(s,before);
 const r=await compose(s,{...args,removedSidecars:'omit'});
 assert.ok((await readFile(path.join(s.destination,'MEDIA','b.wav'))).equals(await readFile(s.media)));
 assert.equal(await mapText(r),`/orig/a.wav\tMEDIA/a.wav\n/orig/c.wav\tMEDIA/c.wav\n${s.media}\tMEDIA/b.wav\n`);
 // A removed row's source may come back as new media under another name: the value stays mapped, to the fresh copy.
 s=await session(t,{map:media=>`/orig/a.wav\tMEDIA/a.wav\n${media}\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n`});
 const back=await compose(s,{media:[{source:s.media,sidecarName:'fresh.wav'}],tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,attributes:{file:s.media}}]}],mediaMapOperations:[{action:'remove_mapping',line:2,sourcePath:s.media,archivePath:'MEDIA/b.wav'}],removedSidecars:'omit'});
 assert.equal(await mapText(back),`/orig/a.wav\tMEDIA/a.wav\n/orig/c.wav\tMEDIA/c.wav\n${s.media}\tMEDIA/fresh.wav\n`);
 assert.deepEqual(back.mediaMap.operations[0].oldSidecar,'omitted');
 assert.deepEqual(back.clipLinks.map(l=>[l.file,l.mappingLine,l.archivePath]),[[s.media,3,'MEDIA/fresh.wav']]);
});

test('a destination that appears during the call is kept, and staging is rolled back',async t=>{
 // A 32 MiB sidecar keeps the call busy long enough for the watcher to create the destination before publication.
 const s=await session(t,{big:true}),before=await tree(s.root);let created=false;
 const watcher=watch(s.dir,async(event,name)=>{
  if(created||!String(name).startsWith('.showkontrol-session-staging-'))return;created=true;
  await mkdir(s.destination);await writeFile(path.join(s.destination,'foreign.txt'),'not ours');
 });
 t.after(()=>watcher.close());
 await assert.rejects(compose(s,{mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'}),/Destination session already exists/);
 assert.equal(created,true);
 assert.deepEqual(await readdir(s.destination),['foreign.txt']);
 assert.equal(await readFile(path.join(s.destination,'foreign.txt'),'utf8'),'not ours');
 assert.deepEqual(await temps(s.dir),[]);
 assert.deepEqual(await tree(s.root),before);
});

test('MCP inspects unmapped sidecars and composes a session with mapping operations',async t=>{
 const s=await session(t),before=await tree(s.root);
 const client=new Client({name:'session-map-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const inspected=JSON.parse((await client.callTool({name:'showkontrol_inspect_session_media',arguments:{directory:s.root}})).content[0].text);
 assert.deepEqual(inspected.unmappedMediaEntries,[{path:'MEDIA/stray.wav',kind:'regular_file',size:10}]);
 const call=extra=>client.callTool({name:'showkontrol_compose_session_media_copy',arguments:{source:s.root,destination:s.destination,sha256:inspected.showSha256,...extra}});
 for(const bad of [{mediaMapOperations:[remove(2,'b')],removedSidecars:'delete'},{mediaMapOperations:[{...remove(2,'b'),mediaIndex:0}],removedSidecars:'omit'},{mediaMapOperations:[remove(1,'a')],removedSidecars:'omit'}]){
  const r=await call(bad);assert.equal(r.isError,true,JSON.stringify(bad));await assertNothingPublished(s,before);
 }
 const r=await call({mediaMapOperations:[remove(2,'b')],removedSidecars:'keep'});
 assert.equal(r.isError,undefined,r.content?.[0]?.text);
 const data=JSON.parse(r.content[0].text);
 assert.deepEqual(data.mediaMap.operations.map(o=>[o.action,o.line,o.oldSidecar]),[['remove_mapping',2,'kept']]);
 const tool=(await client.listTools()).tools.find(x=>x.name==='showkontrol_compose_session_media_copy');
 assert.deepEqual(tool.inputSchema.properties.removedSidecars.enum,['keep','omit']);
 assert.deepEqual(tool.inputSchema.properties.mediaMapOperations.items.oneOf.map(x=>x.properties.action.const),['remove_mapping','repoint_mapping']);
});
