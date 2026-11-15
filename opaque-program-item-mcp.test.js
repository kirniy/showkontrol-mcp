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

test('MCP Program item assembly, node copy and schedule require explicit opaque text opt-in',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'opaque-program-item-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const script='const n42 = 1;',timeline=`<sktimeline version="1"><cue id="src"><graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">${script}</setting></settings></node></graph></cue></sktimeline>`,donor=`<skshow>${part('track.sktl',timeline)}</skshow>`;
 const program='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n100" type="action"/></graph></item><item start="1" name="B" notes=""/></skprogram>',patch='<showkontrol version="2"><graph><node id="n30" type="groupin"/></graph><appSettings/></showkontrol>',show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`,empty=`<skshow>${part('patch.skf',patch)}</skshow>`;
 await Promise.all([writeFile(f('donor.skshow'),donor),writeFile(f('donor.sktl'),timeline),writeFile(f('source.skshow'),show),writeFile(f('empty.skshow'),empty)]);
 const client=new Client({name:'opaque-program-item',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const cueNode={kind:'cue',template:f('donor.skshow'),templateSha256:hash('sha256',donor),templateName:'track.sktl',templateCueId:'src',nodeId:'n1'};
 const copyNode={action:'copy_item_graph_node',index:0,donorType:'cue',donor:f('donor.skshow'),donorSha256:hash('sha256',donor),donorName:'track.sktl',donorCueId:'src',donorNodeId:'n1'};
 const graph={donor:f('donor.sktl'),donorSha256:hash('sha256',timeline),donorCueId:'src'};
 const cases=[
  {name:'assembly',tool:'showkontrol_compose_program_edits_copy',source:show,file:'source.skshow',args:enabled=>({operations:[{action:'assemble_item_graph',index:1,nodes:[{...cueNode,...(enabled?{allowOpaqueNodeText:true}:{})}]}]}),id:r=>r.assembledItemGraphs[0].nodeIds[0],index:1},
  {name:'node',tool:'showkontrol_compose_program_edits_copy',source:show,file:'source.skshow',args:enabled=>({operations:[{...copyNode,...(enabled?{allowOpaqueNodeText:true}:{})}]}),id:r=>r.copiedItemNodes[0].nodeId,index:0},
  {name:'schedule',tool:'showkontrol_compose_program_schedule_copy',source:empty,file:'empty.skshow',args:enabled=>({items:[{start:0,name:'A',notes:'',graph:{...graph,...(enabled?{allowOpaqueNodeText:true}:{})}}]}),id:r=>r.mappings[0].graph.nodes.n1,index:0},
 ];
 for(const c of cases){
  const base={source:f(c.file),sha256:hash('sha256',c.source)},failed=f(`${c.name}-failed.skshow`);
  const failure=await call(c.tool,{...base,destination:failed,...c.args(false)});assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/unsupported internal references/);await assert.rejects(readFile(failed),{code:'ENOENT'});
  const destination=f(`${c.name}.skshow`),result=parse(await call(c.tool,{...base,destination,...c.args(true)}));const warning=result.warnings.find(w=>w.code==='opaque_node_references_unverified');assert.ok(warning,JSON.stringify(result));assert.deepEqual(warning.scope,{part:'content/Program.skpr',itemIndex:c.index,nodeId:c.id(result),key:'proc.script'});assert.ok(!JSON.stringify(result).includes(script));
  const output=(await readShowPart({file:destination,name:'content/Program.skpr'})).text;assert.ok(output.includes(script));assert.ok(output.includes(`id="${c.id(result)}"`));
 }
});
