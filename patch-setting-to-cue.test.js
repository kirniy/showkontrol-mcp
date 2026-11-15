import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';import {copyPatchSettingToCueShowCopy} from './patch-setting-to-cue.js';import {inspectShowTimeline,inspectCueGraph} from './timeline.js';import {inspectXml} from './xml-copy.js';
test('copy app-saved notification settings to a matching cue action',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-setting-patch-cue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),template=path.join(dir,'donor.skf'),destination=path.join(dir,'out.skshow'),part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`,name='content/Track.sktl';
 const donor='<showkontrol version="2"><graph><node id="n228" type="action" title="FeedbackNotify"><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.message">Stored action fixture</setting></settings></node></graph><appSettings/></showkontrol>',timeline='<sktimeline version="1"><cue id="c1"><graph><node id="n1" type="action"><settings><setting key="notify.message">old</setting></settings></node></graph></cue></sktimeline>',patch=part('patch.skf','<showkontrol version="2"/>'),original=`<skshow>${part(name,timeline)}${patch}</skshow>`;await writeFile(source,original);await writeFile(template,donor);
 const a=await inspectShowTimeline({file:source,name}),b=await inspectXml({file:template}),args={source,destination,sha256:a.sha256,name,cueId:'c1',nodeId:'n1',template,templateFormat:'skf',templateSha256:b.sha256,templateNodeId:'n228',key:'notify.message'};const replaced=await copyPatchSettingToCueShowCopy(args);assert.equal(replaced.replaced,true);assert.equal((await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph.nodes[0].settings[0].value,'Stored action fixture');assert.ok((await readFile(destination,'utf8')).includes(patch));assert.equal(await readFile(source,'utf8'),original);
 const next=await inspectShowTimeline({file:destination,name}),added=path.join(dir,'added.skshow');const result=await copyPatchSettingToCueShowCopy({...args,source:destination,destination:added,sha256:next.sha256,key:'action.t7'});assert.equal(result.replaced,false);assert.equal((await inspectCueGraph({file:added,format:'skshow',name,cueId:'c1'})).graph.nodes[0].settings.find(s=>s.key==='action.t7').value,'Feedback/Notify');
 await assert.rejects(copyPatchSettingToCueShowCopy({...args,destination:path.join(dir,'stale'),templateSha256:'0'.repeat(64)}),/Template changed/);await assert.rejects(copyPatchSettingToCueShowCopy(args),/EEXIST/);
 const bad=donor.replace('Stored action fixture','n<![CDATA[12]]>');await writeFile(template,bad);const badInfo=await inspectXml({file:template});await assert.rejects(copyPatchSettingToCueShowCopy({...args,destination:path.join(dir,'ref'),templateSha256:badInfo.sha256}),/unsupported node references/);await assert.rejects(readFile(path.join(dir,'ref')),/ENOENT/);
});
test('copy router target only when it matches one destination router name',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-router-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),template=path.join(dir,'donor.skf'),name='content/Track.sktl',part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline='<sktimeline version="1"><cue id="c1"><graph><node id="n1" type="action"><settings/></node></graph></cue></sktimeline>';
 const show=patch=>`<skshow>${part(name,timeline)}${part('patch.skf',patch)}</skshow>`,donor=setting=>`<showkontrol version="2"><graph><node id="n228" type="action"><settings>${setting}</settings></node></graph></showkontrol>`,setting=value=>`<setting key="route.router_target">${value}</setting>`;
 const run=async (patch,xml,label,expected)=>{await writeFile(source,show(patch));await writeFile(template,donor(xml));const a=await inspectShowTimeline({file:source,name}),b=await inspectXml({file:template}),destination=path.join(dir,label),args={source,destination,sha256:a.sha256,name,cueId:'c1',nodeId:'n1',template,templateFormat:'skf',templateSha256:b.sha256,templateNodeId:'n228',key:'route.router_target'};if(expected!==undefined){const result=await copyPatchSettingToCueShowCopy(args);assert.equal(result.value,expected);assert.equal((await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph.nodes[0].settings[0].value,expected);}else{await assert.rejects(copyPatchSettingToCueShowCopy(args),/router target/i);await assert.rejects(readFile(destination),/ENOENT/);}};
 const patch=node=>`<showkontrol version="2"><graph>${node}</graph></showkontrol>`,router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
 await run(patch(router('n8','A')),setting('A'),'valid','A');
 await run(patch(router('n8','A')),setting('n8'),'node-id');
 await run(patch('<node id="n8" type="router" title="Router A"><settings><setting key="router.name">A</setting></settings></node>'),setting('Router A'),'title');
 await run(patch(router('n8','n8')),setting('n8'),'id-like-name','n8');
 await run(patch(''),setting('A'),'missing');
 await run(patch('<node id="n8" type="action"><settings><setting key="router.name">A</setting></settings></node>'),setting('A'),'wrong-type');
 await run(patch(router('n8','A')+router('n9','A')),setting('A'),'duplicate-name');
 await run(patch(router('n8','A')+router('n8','B')),setting('A'),'duplicate-id');
 await run(patch('<node id="n8" type="router"><settings><setting key="router.name">A</setting><setting key="router.name">B</setting></settings></node>'),setting('A'),'duplicate-setting');
 await run(patch(router('n8','A')),setting('A n9'),'extra-reference');
 await run(patch(router('n8','A')),setting(' A '),'whitespace');
 await run(patch(router('n8','A')),setting(''),'empty');
 await run(patch(router('n8','A')),'<setting key="route.router_target" ref="n9">A</setting>','extra-attribute');
});
test('copy captured Script and OSC settings only to the same type and kind',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-setting-kinds-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),template=path.join(dir,'donor.skf'),name='content/Track.sktl',part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const fixtures=[{type:'processor',kind:'',settings:[['proc.mode','Script'],['proc.language','JavaScript'],['proc.script','// inert capture fixture'],['proc.output_type','String'],['proc.keys_only','true'],['proc.background','false']]},{type:'generator',kind:'OSC',settings:[['gen.enabled','false'],['gen.osc_conn','Custom'],['gen.host','127.0.0.1'],['gen.port','17075'],['gen.address','/mcp/config75'],['gen.osc_count','1'],['gen.a1.value','1'],['gen.a1.type','Integer'],['gen.send_mode','On Trigger']]}];
 for(const [i,fixture] of fixtures.entries()){
  const {type,kind,settings}=fixture,donor=(setting,donorKind=kind)=>`<showkontrol version="2"><graph><node id="n228" type="${type}" kind="${donorKind}"><settings>${setting}</settings></node></graph></showkontrol>`,timeline=(targetType=type,targetKind=kind)=>`<sktimeline version="1"><cue id="c1"><graph><node id="n1" type="${targetType}" kind="${targetKind}"><settings><setting key="${settings[0][0]}">old</setting></settings></node></graph></cue></sktimeline>`,show=xml=>`<skshow>${part(name,xml)}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
  await writeFile(source,show(timeline()));await writeFile(template,donor(settings.map(([key,value])=>`<setting key="${key}">${value}</setting>`).join('')));const a=await inspectShowTimeline({file:source,name}),b=await inspectXml({file:template});let current=source,sha256=a.sha256;
  for(const [j,[key,value]] of settings.entries()){
   const destination=path.join(dir,`out-${i}-${j}`),result=await copyPatchSettingToCueShowCopy({source:current,destination,sha256,name,cueId:'c1',nodeId:'n1',template,templateFormat:'skf',templateSha256:b.sha256,templateNodeId:'n228',key});assert.equal(result.replaced,j===0);assert.equal(result.value,value);assert.equal((await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph.nodes[0].settings.find(s=>s.key===key).value,value);current=destination;sha256=(await inspectShowTimeline({file:current,name})).sha256;
  }
  const run=async (targetXml,donorXml,label,pattern,overrides={})=>{await writeFile(source,show(targetXml));await writeFile(template,donorXml);const src=await inspectShowTimeline({file:source,name}),don=await inspectXml({file:template}),destination=path.join(dir,`bad-${i}-${label}`);await assert.rejects(copyPatchSettingToCueShowCopy({source,destination,sha256:src.sha256,name,cueId:'c1',nodeId:'n1',template,templateFormat:'skf',templateSha256:don.sha256,templateNodeId:'n228',key:settings[0][0],...overrides}),pattern);await assert.rejects(readFile(destination),/ENOENT/);};
  const setting=`<setting key="${settings[0][0]}">${settings[0][1]}</setting>`;
  await run(timeline(type==='processor'?'generator':'processor',kind),donor(setting),'type',/types must match/);
  await run(timeline(type,kind==='OSC'?'LTC':'other'),donor(setting),'kind',/kinds must match/);
  await run(timeline(),donor(setting,'other'),'donor-kind',/supported/);
  await run(timeline(),donor(`<setting key="${settings[0][0]}">n<![CDATA[12]]></setting>`),'reference',/unsupported node references/);
  await run(timeline(),donor(`<setting key="${settings[0][0]}"><nested/></setting>`),'nested',/Nested setting/);
  await run(timeline(),donor(setting),'stale-source',/Source changed/,{sha256:'0'.repeat(64)});
  await run(timeline(),donor(setting),'stale-template',/Template changed/,{templateSha256:'0'.repeat(64)});
  await run(timeline(),donor('<setting key="node.stopped">true</setting>'),'stopped',/Cannot copy node.stopped/,{key:'node.stopped'});
 }
});
