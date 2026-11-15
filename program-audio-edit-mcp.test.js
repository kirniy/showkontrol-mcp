import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {composeSessionMediaCopy} from './session-media-copy.js';

const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
const clip={name:'Kick',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'2000',fadeInMs:'0',fadeOutMs:'250'};
const itemTimeline='<sktimeline version="1" name="Doors"><layers><layer name="L"/></layers><audio name="Main" follow="1"><clip name="Old" file="/orig/old.wav" wave="w" grid="g" pps="315" offsetMs="0" vol="1" trimStartMs="0" trimEndMs="1000" fadeInMs="0" fadeOutMs="0"/></audio><deck/></sktimeline>';
const programXml=`<skprogram version="1"><item start="0" name="Doors" notes="">${itemTimeline}</item></skprogram>`;
const track='<sktimeline version="1" name="Song"><layers><layer name="L"/></layers></sktimeline>';
const patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';

async function connect(t){
 const client=new Client({name:'program-audio-mcp',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(name,args)=>{const response=await client.callTool({name:`showkontrol_${name}`,arguments:args});return {response,data:response.isError?undefined:JSON.parse(response.content[0].text)};};
 return {client,call};
}

test('MCP schemas expose the Program audio operations; mediaIndex only in session composition',async t=>{
 const {client}=await connect(t);
 const {tools}=await client.listTools(),byName=name=>tools.find(x=>x.name===`showkontrol_${name}`).inputSchema;
 const actions=schema=>Object.fromEntries(schema.oneOf.map(o=>[o.properties.action.const,o]));
 const audio=['add_timeline_audio_lane','add_timeline_audio_clip','edit_timeline_audio_clip','remove_timeline_audio_clip','remove_timeline_audio_lane'];
 const direct=actions(byName('compose_program_edits_copy').properties.operations.items);
 const full=actions(byName('compose_full_show_copy').properties.program.anyOf[1].properties.operations.items);
 const session=actions(byName('compose_session_media_copy').properties.program.anyOf[1].properties.operations.items);
 for(const name of audio)for(const set of [direct,full,session])assert.ok(set[name],name);
 assert.deepEqual(Object.keys(direct).sort(),Object.keys(session).sort());
 for(const set of [direct,full])for(const name of ['add_timeline_audio_clip','edit_timeline_audio_clip'])assert.equal(set[name].properties.mediaIndex,undefined);
 assert.ok(session.add_timeline_audio_clip.properties.mediaIndex&&!session.add_timeline_audio_clip.properties.clip.required.includes('file'));
 assert.ok(direct.add_timeline_audio_clip.properties.clip.required.includes('file'));
 assert.ok(session.edit_timeline_audio_clip.properties.mediaIndex);
 // Every other operation is the same in all three tools.
 for(const name of Object.keys(direct).filter(n=>!['add_timeline_audio_clip','edit_timeline_audio_clip'].includes(n)))assert.deepEqual(session[name],direct[name],name);
});

test('MCP edits audio in an existing Program item timeline of a show copy',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-audio-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const show=`<skshow>${part('content/Song.sktl',track)}${part('patch.skf',patch)}${part('content/Program.skpr',programXml)}</skshow>`;
 const source=path.join(dir,'in.skshow');await writeFile(source,show);
 const {call}=await connect(t);
 const program=(await call('inspect_show_program',{file:source})).data;
 const before=(await call('inspect_program_timeline',{file:source,sha256:program.sha256,index:0})).data;
 assert.deepEqual(before.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name]),[[0,0,'Old']]);
 const destination=path.join(dir,'out.skshow');
 const operations=[{action:'add_timeline_audio_lane',index:0,laneName:'Stems',follow:false},{action:'add_timeline_audio_clip',index:0,audioIndex:1,clip:{...clip,file:'/media/kick.wav'}},{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0}];
 const {response,data}=await call('compose_program_edits_copy',{source,destination,sha256:program.sha256,operations});
 assert.equal(response.isError,undefined,JSON.stringify(response));
 const after=(await call('inspect_program_timeline',{file:destination,sha256:data.sha256,index:0})).data;
 assert.deepEqual(after.audio,[{name:'Main',follow:'1'},{name:'Stems',follow:'0'}]);
 assert.deepEqual(after.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.file]),[[1,0,'/media/kick.wav']]);
 const validation=(await call('validate_show',{file:destination})).data;
 assert.deepEqual(validation.diagnostics.filter(d=>d.severity==='error'),[]);
 // Schema rejections and composer rejections both publish nothing.
 for(const bad of [
  [{action:'add_timeline_audio_clip',index:0,audioIndex:0,mediaIndex:0,clip:{...clip,file:'/x.wav'}}],
  [{action:'add_timeline_audio_clip',index:0,laneName:'Main',clip:{...clip,file:'/x.wav'}}],
  [{action:'remove_timeline_audio_lane',index:0,audioIndex:0}]
 ]){
  const failed=await call('compose_program_edits_copy',{source,destination:path.join(dir,'bad.skshow'),sha256:program.sha256,operations:bad});
  assert.equal(failed.response.isError,true,JSON.stringify(bad));
 }
 assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
 assert.equal(await readFile(source,'utf8'),show);
});

test('MCP session composition re-points and adds Program item clips with mediaIndex',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'program-audio-session-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const session=path.join(dir,'Session A'),library=path.join(dir,'library');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(path.join(session,'TIMELINE'));await mkdir(library);
 await writeFile(path.join(session,'MEDIA','old.wav'),'RIFF-old');
 const show=`<skshow>${part('media.map','/orig/old.wav\tMEDIA/old.wav\n')}${part('content/Song.sktl',track)}${part('patch.skf',patch)}${part('content/Program.skpr',programXml)}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),show);
 await writeFile(path.join(session,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 await writeFile(path.join(session,'TIMELINE','Song.sktl'),track);
 const kick=path.join(library,'kick.wav');await writeFile(kick,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(2048,7)]));
 const {call}=await connect(t);
 const inspected=(await call('inspect_session_media',{directory:session})).data;
 assert.deepEqual(inspected.clips.map(c=>[c.part,c.itemIndex,c.audioIndex,c.clipIndex,c.mapping?.line]),[['content/Program.skpr',0,0,0,1]]);
 const operations=[
  {action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{name:'Kick',wave:'',grid:''}},
  {action:'add_timeline_audio_lane',index:0,laneName:'Stems',follow:true},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,mediaIndex:0,clip}
 ];
 const args={source:session,destination:path.join(dir,'Session B'),sha256:inspected.showSha256,media:[{source:kick}],program:{operations}};
 const {response,data:r}=await call('compose_session_media_copy',args);
 assert.equal(response.isError,undefined,JSON.stringify(response));
 // Independent reads of the published session.
 const media=(await call('inspect_show_media',{file:r.sessionFile})).data;
 assert.deepEqual(media.mappings.map(m=>[m.line,m.sourcePath,m.archivePath]),[[1,'/orig/old.wav','MEDIA/old.wav'],[2,kick,'MEDIA/kick.wav']]);
 assert.deepEqual(media.clips.map(c=>[c.itemIndex,c.audioIndex,c.clipIndex,c.attributes.name,c.attributes.file,c.attributes.wave]),[[0,0,0,'Kick',kick,''],[0,1,0,'Kick',kick,'']]);
 const sidecars=(await call('inspect_session_media',{directory:r.destination})).data;
 assert.deepEqual(sidecars.findings.map(x=>[x.archivePath,x.status]),[['MEDIA/old.wav','regular_file'],['MEDIA/kick.wav','regular_file']]);
 assert.ok((await readFile(path.join(r.destination,'MEDIA','kick.wav'))).equals(await readFile(kick)));
 assert.equal(await readFile(path.join(r.destination,'MEDIA','old.wav'),'utf8'),'RIFF-old');
 // Receipts agree with the reads.
 assert.deepEqual(r.programClipLinks,[{itemIndex:0,audioIndex:0,clipIndex:0,file:kick,mappingLine:2,archivePath:'MEDIA/kick.wav',sidecar:'copied'},{itemIndex:0,audioIndex:1,clipIndex:0,file:kick,mappingLine:2,archivePath:'MEDIA/kick.wav',sidecar:'copied'}]);
 assert.deepEqual(r.program.audioOperations.map(o=>[o.action,o.audioIndex,o.clipIndex]),[['edit_timeline_audio_clip',0,0],['add_timeline_audio_lane',1,undefined],['add_timeline_audio_clip',1,0]]);
 assert.deepEqual(r.warnings.filter(w=>w.code==='mapping_no_longer_referenced').map(w=>[w.line,w.sourcePath]),[[1,'/orig/old.wav']]);
 assert.equal(r.validation.file,r.sessionFile);
 assert.deepEqual(Object.fromEntries(r.workingFiles.entries.map(e=>[e.path,e.action])),{'TIMELINE/Song.sktl':'copied','session.skf':'copied'});
 // Invalid mediaIndex uses publish nothing.
 for(const [bad,message] of [
  [{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,mediaIndex:0},/Unrecognized key: "mediaIndex"/],
  [{action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{file:'/x.wav'}},/mediaIndex supplies attributes\.file; omit file/],
  [{action:'add_timeline_audio_clip',index:0,audioIndex:0,mediaIndex:3,clip},/Program operation 0: mediaIndex must select an entry in media/],
  [{action:'add_timeline_audio_clip',index:0,audioIndex:0,clip},/Provide all supported clip fields/]
 ]){
  const failed=await call('compose_session_media_copy',{...args,destination:path.join(dir,'Session C'),program:{operations:[bad]}});
  assert.equal(failed.response.isError,true,JSON.stringify(bad));
  assert.match(failed.response.content[0].text,message);
 }
 // Direct callers bypass the MCP schema; the session composer rejects the same input itself.
 await assert.rejects(composeSessionMediaCopy({...args,destination:path.join(dir,'Session D'),program:{operations:[{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,mediaIndex:0}]}}),/Program operation 0: mediaIndex is supported only on add_timeline_audio_clip and edit_timeline_audio_clip/);
 assert.deepEqual((await readdir(dir)).sort(),['Session A','Session B','library']);
 assert.equal(await readFile(path.join(session,'session.skshow'),'utf8'),show);
});
