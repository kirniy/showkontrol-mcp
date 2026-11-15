import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP exposes and uses external track templates for creation and multi-track composition',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-template-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),donorFile=path.join(dir,'empty.sktl'),donorShow=path.join(dir,'donor.skshow');
 const empty='<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>';
 const occupied='<sktimeline version="1" name="Occupied"><layers><layer name="Layer 1"/></layers><cue id="c1"/></sktimeline>';
 const original=`<skshow>${part('content/Occupied.sktl',occupied)}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,original);await writeFile(donorFile,empty);await writeFile(donorShow,`<skshow>${part('content/Empty.sktl',empty)}</skshow>`);
 const client=new Client({name:'track-template-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const listed=(await client.listTools()).tools,create='showkontrol_create_show_track_copy',multi='showkontrol_compose_multi_track_show_copy';
 const createSchema=listed.find(x=>x.name===create).inputSchema.properties.templateDonor;
 const multiSchema=listed.find(x=>x.name===multi).inputSchema.properties.tracks.items.properties.templateDonor;
 for(const schema of [createSchema,multiSchema]){assert.ok(schema);assert.deepEqual(schema.properties.format.enum,['sktl','skshow']);for(const key of ['file','format','sha256'])assert.ok(schema.required.includes(key));assert.ok(schema.properties.name);}
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const sourceInfo=await call('showkontrol_inspect_show',{file:source});
 const timelineInfo=await call('showkontrol_inspect_timeline',{file:donorFile});
 const showInfo=await call('showkontrol_inspect_show_timeline',{file:donorShow,name:'content/Empty.sktl'});
 const standalone={file:donorFile,format:'sktl',sha256:timelineInfo.sha256};
 const show={file:donorShow,format:'skshow',sha256:showInfo.sha256,name:'content/Empty.sktl'};
 const first=path.join(dir,'first.skshow');
 await call(create,{source,destination:first,sha256:sourceInfo.sha256,templateDonor:standalone,trackName:'Created',partName:'content/Created.sktl'});
 const created=await call('showkontrol_inspect_show_timeline',{file:first,name:'content/Created.sktl'});assert.equal(created.attributes.name,'Created');assert.equal(created.cueElements.length,0);
 const second=path.join(dir,'second.skshow');
 await call(multi,{source,destination:second,sha256:sourceInfo.sha256,tracks:[{templateDonor:show,trackName:'One',partName:'content/One.sktl',cues:[{layer:0,startMs:0,lengthMs:10,label:'Cue'}]},{templateDonor:standalone,trackName:'Two',partName:'content/Two.sktl'}]});
 const one=await call('showkontrol_inspect_show_timeline',{file:second,name:'content/One.sktl'}),two=await call('showkontrol_inspect_show_timeline',{file:second,name:'content/Two.sktl'});
 assert.equal(one.attributes.name,'One');assert.equal(one.cueElements[0].attributes.label,'Cue');assert.equal(two.attributes.name,'Two');assert.equal(two.cueElements.length,0);
 const failed=path.join(dir,'failed.skshow');const error=await client.callTool({name:create,arguments:{source,destination:failed,sha256:sourceInfo.sha256,templateDonor:{...standalone,sha256:'0'.repeat(64)},trackName:'Bad',partName:'content/Bad.sktl'}});assert.equal(error.isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),original);
});
