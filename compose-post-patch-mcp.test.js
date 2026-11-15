import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP passes post-patch settings through track and full composition and reports final stopped state',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-post-patch-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
 const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
 const source=path.join(dir,'source.skshow'),donor=path.join(dir,'donor.skshow'),template=path.join(dir,'patch.skf');
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donorXml=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting></settings></node><node id="n2" type="action"><settings><setting key="notify.message">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n8" type="action"><settings><setting key="notify.message">copied</setting></settings></node></graph></showkontrol>';
 await Promise.all([writeFile(source,input),writeFile(donor,donorXml),writeFile(template,patch)]);
 const client=new Client({name:'post-patch-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args}),parse=r=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const cue=(stopped)=>({layer:0,startMs:0,lengthMs:40,label:'Cue',patchSettings:[{nodeId:'n2',key:'notify.message',template,templateFormat:'skf',templateSha256:hash('sha256',patch),templateNodeId:'n8'}],postPatchSettings:[{nodeId:'n2',key:'notify.message',value:'final'},{nodeId:'n1',key:'node.stopped',value:stopped}]});
 const track={templateName:'Empty.sktl',trackName:'New',partName:'content/New.sktl',donor:{file:donor,sha256:hash('sha256',donorXml),name:'Donor.sktl',cueId:'d'},cues:[cue('false'),cue('true')]};
 for(const mode of ['track','multi','full']){
  const destination=path.join(dir,`${mode}.skshow`);
  const tool={track:'showkontrol_compose_show_copy',multi:'showkontrol_compose_multi_track_show_copy',full:'showkontrol_compose_full_show_copy'}[mode];
  const result=parse(await call(tool,{source,destination,sha256:hash('sha256',input),...(mode==='track'?track:{tracks:[track]})}));
  const cues=mode==='track'?result.cues:result.tracks[0].cues;
  assert.deepEqual(result.warnings.map(w=>[w.scope.part,w.scope.cueId,w.scope.nodeId]),[[track.partName,cues[1].id,cues[1].idMap.n1]]);
  for(const [i,item] of cues.entries()){
   const graph=parse(await call('showkontrol_inspect_cue_graph',{file:destination,format:'skshow',name:track.partName,cueId:item.id})).graph;
   assert.equal(graph.nodes.find(n=>n.id===item.idMap.n2).settings.find(s=>s.key==='notify.message').value,'final');
   assert.equal(graph.nodes.find(n=>n.id===item.idMap.n1).settings.find(s=>s.key==='node.stopped').value,i?'true':'false');
  }
 }
 for(const [file,original] of [[source,input],[donor,donorXml],[template,patch]])assert.equal(await readFile(file,'utf8'),original);
});
