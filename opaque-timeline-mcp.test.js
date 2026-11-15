import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';
const hash=(kind,s)=>createHash(kind).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
const parse=r=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
test('MCP timeline embed, schedule and staged full show require opaque text opt-in',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'opaque-timeline-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const script='const n42 = 1;',timeline=`<sktimeline version="1"><layers/><cue id="src"><graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">${script}</setting></settings></node></graph></cue></sktimeline>`;
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>',patch='<showkontrol version="2"><graph/><appSettings/></showkontrol>',show=`<skshow>${part('patch.skf',patch)}</skshow>`,input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf',patch)}</skshow>`,donorShow=`<skshow>${part('Donor.sktl',timeline)}</skshow>`;
 await Promise.all([writeFile(f('in.skpr'),program),writeFile(f('donor.sktl'),timeline),writeFile(f('target.skshow'),show),writeFile(f('input.skshow'),input),writeFile(f('donor.skshow'),donorShow)]);
 const client=new Client({name:'opaque-timeline-mcp',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());const call=(name,args)=>client.callTool({name:`showkontrol_${name}`,arguments:args});
 const embed={source:f('in.skpr'),sha256:hash('sha256',program),index:0,donor:f('donor.sktl'),donorSha256:hash('sha256',timeline),target:f('target.skshow'),targetSha256:hash('sha256',show),remapCueIds:true};
 const scheduleTimeline={donor:f('donor.sktl'),donorSha256:hash('sha256',timeline),remapCueIds:true,settings:[{cueId:'src',nodeId:'n1',key:'proc.script',value:script}]};
 const schedule={source:f('target.skshow'),sha256:hash('sha256',show),items:[{start:0,name:'A',notes:'',timeline:scheduleTimeline}]};
 const full={source:f('input.skshow'),sha256:hash('sha256',input),tracks:[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',donor:{file:f('donor.skshow'),sha256:hash('sha256',donorShow),name:'Donor.sktl',cueId:'src',allowOpaqueNodeText:true},cues:[{layer:0,startMs:0,lengthMs:100,label:'Cue'}]}],program:{items:[{start:0,name:'A',notes:'',timeline:{stagedShow:{trackIndex:0},remapCueIds:true,settings:[{cueIndex:0,nodeIndex:0,key:'proc.script',value:script}]}}]}};
 const cases=[
  {tool:'embed_remapped_program_timeline_copy',args:enabled=>({...embed,...(enabled?{allowOpaqueNodeText:true}:{})}),mapped:r=>({cue:r.cueMapping.src,node:r.mapping.n1}),part:(dest)=>dest},
  {tool:'compose_program_schedule_copy',args:enabled=>({...schedule,items:[{...schedule.items[0],timeline:{...scheduleTimeline,...(enabled?{allowOpaqueNodeText:true}:{})}}]}),mapped:r=>({cue:r.mappings[0].timeline.cues.src,node:r.mappings[0].timeline.nodes.n1}),part:()=> 'content/Program.skpr'},
  {tool:'compose_full_show_copy',args:enabled=>({...full,program:{items:[{...full.program.items[0],timeline:{...full.program.items[0].timeline,...(enabled?{allowOpaqueNodeText:true}:{})}}]}}),mapped:r=>{const cue=r.tracks[0].cues[0],m=r.program.mappings[0].timeline;return {cue:m.cues[cue.id],node:m.nodes[cue.idMap.n1]};},part:()=> 'content/Program.skpr',full:true},
 ];
 for(const [i,c] of cases.entries()){
  const failed=f(`failed-${i}.${i?'skshow':'skpr'}`);const failure=await call(c.tool,{...c.args(false),destination:failed});assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/unsupported node references/);await assert.rejects(readFile(failed),{code:'ENOENT'});
  const destination=f(`out-${i}.${i?'skshow':'skpr'}`),result=parse(await call(c.tool,{...c.args(true),destination})),m=c.mapped(result),warnings=c.full?result.program.warnings:result.warnings;const warning=warnings.find(w=>w.code==='opaque_node_references_unverified');assert.deepEqual(warning.scope,{part:c.part(destination),cueId:m.cue,nodeId:m.node,key:'proc.script',itemIndex:0});
  const xml=i?(await readShowPart({file:destination,name:'content/Program.skpr'})).text:await readFile(destination,'utf8');assert.ok(xml.includes(script));assert.ok(xml.includes(`id="${m.node}"`));assert.ok(xml.includes(`id="${m.cue}"`));
 }
});
