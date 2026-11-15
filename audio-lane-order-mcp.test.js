import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const lanes='<audio name="Audio 1" follow="0"/><audio name="Vox" follow="1"/><audio name="Click" follow="0"/>';
const timeline=`<sktimeline version="1" name="A"><titles/><layers><layer name="Layer 1"/></layers>${lanes}</sktimeline>`;
const program=`<skprogram version="1"><item start="0" name="Doors" notes="">${timeline}</item></skprogram>`;

async function connect(t){
 const client=new Client({name:'lane-order-mcp',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(name,args)=>{const response=await client.callTool({name:`showkontrol_${name}`,arguments:args});return {response,data:response.isError?undefined:JSON.parse(response.content[0].text)};};
 return {client,call};
}

test('MCP exposes lane rename and move with precise selectors in every composer',async t=>{
 const {client}=await connect(t),{tools}=await client.listTools(),schema=name=>tools.find(x=>x.name===`showkontrol_${name}`).inputSchema;
 for(const name of ['rename_timeline_audio_lane_copy','move_timeline_audio_lane_copy']){
  const s=schema(name);assert.ok(s.required.includes('laneName')&&s.required.includes('audioIndex'),name);
 }
 assert.ok(schema('rename_timeline_audio_lane_copy').required.includes('newName'));assert.ok(schema('move_timeline_audio_lane_copy').required.includes('toIndex'));
 const actions=s=>Object.fromEntries(s.oneOf.map(o=>[o.properties.action.const,o]));
 for(const set of [actions(schema('compose_program_edits_copy').properties.operations.items),actions(schema('compose_full_show_copy').properties.program.anyOf[1].properties.operations.items),actions(schema('compose_session_media_copy').properties.program.anyOf[1].properties.operations.items)]){
  assert.deepEqual(set.rename_timeline_audio_lane.required.sort(),['action','audioIndex','index','laneName','newName']);
  assert.deepEqual(set.move_timeline_audio_lane.required.sort(),['action','audioIndex','index','laneName','toIndex']);
  assert.equal(set.move_timeline_audio_lane.additionalProperties,false);
 }
 const track=s=>s.properties.tracks?.items??s;
 for(const s of [schema('compose_show_copy'),track(schema('compose_multi_track_show_copy')),track(schema('compose_full_show_copy')),track(schema('compose_session_media_copy'))]){
  const variants=s.properties.audioLaneOperations.items.oneOf;
  assert.deepEqual(variants.map(v=>[v.properties.operation.const,v.required.sort()]),[['rename',['audioIndex','laneName','newName','operation']],['move',['audioIndex','laneName','operation','toIndex']]]);
 }
});

test('MCP rename and move write show copies; strict schemas and app-semantics refusals publish nothing',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-lane-order-mcp-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const show=`<skshow>${part('content/A.sktl',timeline)}${part('content/Program.skpr',program)}</skshow>`,source=path.join(dir,'in.skshow');await writeFile(source,show);
 const {call}=await connect(t),base={source,format:'skshow',sha256:sha(show),name:'content/A.sktl'};
 const moved=await call('move_timeline_audio_lane_copy',{...base,destination:path.join(dir,'moved.skshow'),audioIndex:2,laneName:'Click',toIndex:1});
 assert.deepEqual(moved.data.indexMap,[{from:1,to:2},{from:2,to:1}]);
 const text=async(file,name)=>readSnapshotPart({snapshot:await readShowSnapshot({file}),name}).text;
 assert.equal(await text(moved.data.destination,'content/A.sktl'),timeline.replace(lanes,'<audio name="Audio 1" follow="0"/><audio name="Click" follow="0"/><audio name="Vox" follow="1"/>'));
 assert.equal(await text(moved.data.destination,'content/Program.skpr'),program);
 const renamed=await call('rename_timeline_audio_lane_copy',{...base,destination:path.join(dir,'renamed.skshow'),audioIndex:1,laneName:'Vox',newName:'Lead'});
 assert.equal(await text(renamed.data.destination,'content/A.sktl'),timeline.replace('name="Vox"','name="Lead"'));
 const program2=await call('compose_program_edits_copy',{source,destination:path.join(dir,'program.skshow'),sha256:sha(show),operations:[{action:'move_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',toIndex:2},{action:'rename_timeline_audio_lane',index:0,audioIndex:2,laneName:'Vox',newName:'Lead'}]});
 assert.equal(await text(program2.data.destination,'content/Program.skpr'),program.replace(lanes,'<audio name="Audio 1" follow="0"/><audio name="Click" follow="0"/><audio name="Lead" follow="1"/>'));
 const files=await readdir(dir);
 for(const [name,args,pattern] of [
  ['move_timeline_audio_lane_copy',{...base,destination:path.join(dir,'x.skshow'),audioIndex:1,laneName:'Vox',toIndex:0},/first position/],
  ['move_timeline_audio_lane_copy',{...base,destination:path.join(dir,'x.skshow'),audioIndex:1,toIndex:2},/laneName/],
  ['rename_timeline_audio_lane_copy',{...base,destination:path.join(dir,'x.skshow'),audioIndex:0,laneName:'Audio 1',newName:'Song'},/"Audio 1"/],
  ['compose_show_copy',{source,destination:path.join(dir,'x.skshow'),sha256:sha(show),existingPartName:'content/A.sktl',audioLaneOperations:[{operation:'move',audioIndex:1,laneName:'Vox',toIndex:2,newName:'x'}]},/newName|Unrecognized|Invalid/],
 ]){
  const r=await call(name,args);assert.ok(r.response.isError,name);assert.match(r.response.content[0].text,pattern);
 }
 assert.deepEqual(await readdir(dir),files);assert.equal(await readFile(source,'utf8'),show);
});
