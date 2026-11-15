import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {copyCueGraphInShow,copyCueGraphBetweenTimelines,inspectShowTimeline,inspectTimeline,inspectCueGraph} from './timeline.js';
import {copyCueGraphsInShow} from './batch-graphs.js';

test('graph copy guards references and router dependencies before publishing',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const hash=x=>createHash('sha256').update(x).digest('hex'),name='Track.sktl';
 const graph=value=>`<graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node><node id="n2" type="action"><settings>${value}</settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph>`;
 const tl=value=>`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="s">${graph(value)}</cue><cue id="t"/><cue id="u"/></sktimeline>`;
 const setting=value=>`<setting key="notify.message">${value}</setting>`,router=value=>`<setting key="route.router_target">${value}</setting>`;
 const patch=name=>`<showkontrol version="2"><graph>${name?`<node id="n50" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`:''}</graph></showkontrol>`;
 const source=path.join(dir,'source.skshow'),donor=path.join(dir,'donor.skshow'),out=path.join(dir,'out.skshow');
 const target=`<skshow>${part(name,tl(setting('Safe')))}${part('patch.skf',patch('A'))}</skshow>`;await writeFile(source,target);const targetHash=hash(target);
 const args={source,destination:out,sha256:targetHash,name,sourceCueId:'s',targetCueId:'t',template:donor};
 for(const value of [setting('n&#49;'),setting('n<![CDATA[1]]><!-- split -->'),'<setting key="x" ref="n2">safe</setting>',router('Missing')]){
  const content=`<skshow>${part(name,tl(value))}</skshow>`;await writeFile(donor,content);
  await assert.rejects(copyCueGraphInShow({...args,templateSha256:hash(content)}),/reference|router target/i);await assert.rejects(readFile(out),{code:'ENOENT'});
 }
 for(const nested of ['<extra fromNode="n999"/>','<![CDATA[ fromNode="n999" ]]>']){
  const unsafeTimeline=tl(setting('Safe')).replace('toPin="0"/>',`toPin="0">${nested}</connection>`);
  const content=`<skshow>${part(name,unsafeTimeline)}</skshow>`;await writeFile(donor,content);
  await assert.rejects(copyCueGraphInShow({...args,templateSha256:hash(content)}),/reference/);await assert.rejects(readFile(out),{code:'ENOENT'});
 }
 for(const value of [setting('Notification'),router('A')]){
  const content=`<skshow>${part(name,tl(value))}</skshow>`;await writeFile(donor,content);const result=await copyCueGraphInShow({...args,templateSha256:hash(content)});assert.deepEqual(result.idMap,{n1:'n51',n2:'n52'});const g=(await inspectCueGraph({file:out,format:'skshow',name,cueId:'t'})).graph;assert.equal(g.connections[0].toNode,'n52');await rm(out);
 }
 const st=path.join(dir,'target.sktl'),sd=path.join(dir,'donor.sktl');await writeFile(st,tl(setting('Safe')));await writeFile(sd,tl(router('A')));await assert.rejects(copyCueGraphBetweenTimelines({source:st,destination:out,sha256:(await inspectTimeline({file:st})).sha256,template:sd,templateSha256:(await inspectTimeline({file:sd})).sha256,sourceCueId:'s',targetCueId:'t'}),/router target/i);await assert.rejects(readFile(out),{code:'ENOENT'});
 const unsafe=`<skshow>${part(name,tl(setting('n&#49;')))}</skshow>`;await writeFile(donor,unsafe);const copies=[{name,sourceCueId:'s',targetCueId:'t'},{name,sourceCueId:'s',targetCueId:'u',template:donor,templateSha256:hash(unsafe)}];await assert.rejects(copyCueGraphsInShow({source,destination:out,sha256:targetHash,copies}),/reference/);await assert.rejects(readFile(out),{code:'ENOENT'});
 const client=new Client({name:'graph-reference-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const batch=await call('showkontrol_copy_cue_graphs_show_copy',{source,destination:out,sha256:targetHash,copies});assert.equal(batch.isError,true);await assert.rejects(readFile(out),{code:'ENOENT'});
 const composed=await call('showkontrol_compose_show_copy',{source,destination:out,sha256:targetHash,existingPartName:name,donor:{file:donor,sha256:hash(unsafe),name,cueId:'s'},cues:[{layer:0,startMs:0,lengthMs:40,label:'Test'}]});assert.equal(composed.isError,true);assert.match(composed.content[0].text,/reference/);await assert.rejects(readFile(out),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),target);
});
