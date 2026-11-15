import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeShowCopy} from './compose-show.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';
import {inspectCueGraph} from './timeline.js';
import {readShowPart} from './xml-copy.js';

test('post-patch settings customize copied Script and OSC settings atomically', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-post-patch-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const source=path.join(dir,'source.skshow'),donor=path.join(dir,'donor.skshow'),template=path.join(dir,'patch.skf');
 const input=`<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="L"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 const nodes='<node id="n1" type="processor" kind="" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="proc.script">old</setting></settings></node><node id="n2" type="generator" kind="OSC" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="gen.enabled">false</setting></settings></node>';
 const donorXml=`<skshow>${part('content/Donor.sktl',`<sktimeline version="1"><cue id="src"><graph>${nodes}</graph></cue><cue id="action"><graph><node id="n3" type="action"><settings><setting key="notify.message">old</setting></settings></node></graph></cue></sktimeline>`)}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n8" type="processor" kind="" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="proc.script">copied script</setting></settings></node><node id="n9" type="generator" kind="OSC" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="gen.enabled">false</setting><setting key="gen.address">/copied</setting></settings></node><node id="n10" type="action"><settings><setting key="notify.message">copied</setting></settings></node></graph></showkontrol>';
 const graphTemplate=path.join(dir,'graph.skf'),graphPatch=patch.replace('<setting key="gen.address">/copied</setting>','');
 await Promise.all([writeFile(source,input),writeFile(donor,donorXml),writeFile(template,patch),writeFile(graphTemplate,graphPatch)]);
 const patchSetting=(selector,templateNodeId,key)=>({...selector,template,templateFormat:'skf',templateSha256:hash(patch),templateNodeId,key});
 const donorCue={layer:0,startMs:0,lengthMs:40,label:'Donor',settings:[{nodeId:'n3',key:'notify.message',value:'before'}],patchSettings:[patchSetting({nodeId:'n3'},'n10','notify.message')],postPatchSettings:[{nodeId:'n3',key:'notify.message',value:'after'}]};
 const mixedGraph={nodes:[{kind:'patch',template,templateSha256:hash(patch),templateFormat:'skf',nodeId:'n8'},{kind:'patch',template:graphTemplate,templateSha256:hash(graphPatch),templateFormat:'skf',nodeId:'n9'}],wires:[]};
 const mixedCue={...donorCue,mixedGraph,settings:[{nodeIndex:0,key:'proc.script',value:'before'}],patchSettings:[patchSetting({nodeIndex:0},'n8','proc.script'),patchSetting({nodeIndex:1},'n9','gen.address')],postPatchSettings:[{nodeIndex:0,key:'proc.script',value:'after'},{nodeIndex:1,key:'gen.address',value:'/after'}]};
 const track=(name,cue)=>({templateName:'content/Empty.sktl',trackName:name,partName:`content/${name}.sktl`,donor:{file:donor,sha256:hash(donorXml),name:'content/Donor.sktl',cueId:'action'},cues:[cue]});
 const verify=async(file,entry,name)=>{const graph=(await inspectCueGraph({file,format:'skshow',name,cueId:entry.id})).graph; assert.equal(graph.nodes[0].settings.find(s=>s.key==='proc.script').value,'after');assert.equal(graph.nodes[1].settings.find(s=>s.key==='gen.address').value,'/after');assert.equal(graph.nodes[1].settings.find(s=>s.key==='gen.enabled').value,'false');const xml=(await readShowPart({file,name})).text;assert.equal((xml.match(/stopped="1"/g)||[]).length,2);assert.equal((xml.match(/<setting key="node.stopped">true<\/setting>/g)||[]).length,2);};
 const one=track('One',donorCue),single=path.join(dir,'single.skshow');const result=await composeShowCopy({source,destination:single,sha256:hash(input),...one});assert.equal((await inspectCueGraph({file:single,format:'skshow',name:one.partName,cueId:result.cues[0].id})).graph.nodes[0].settings[0].value,'after');assert.ok(result.cues[0].idMap.n3);
 const two=track('Two',mixedCue),multi=path.join(dir,'multi.skshow');const multiple=await composeMultiTrackShowCopy({source,destination:multi,sha256:hash(input),tracks:[one,two]});await verify(multi,multiple.tracks[1].cues[0],two.partName);assert.equal(multiple.tracks[1].cues[0].nodeIds.length,2);
 for(const cue of [{...mixedCue,postPatchSettings:[{nodeIndex:9,key:'gen.address',value:'x'}]},{...donorCue,postPatchSettings:[{nodeId:'n999',key:'gen.address',value:'x'}]},{...donorCue,postPatchSettings:[{nodeId:'n3',key:'missing',value:'x'}]},{...donorCue,postPatchSettings:[{nodeIndex:0,key:'proc.script',value:'x'}]}]){const failed=path.join(dir,'failed.skshow');await assert.rejects(composeMultiTrackShowCopy({source,destination:failed,sha256:hash(input),tracks:[one,track('Bad',cue)]}));await assert.rejects(readFile(failed),/ENOENT/);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);}
 for(const [file,original] of [[source,input],[donor,donorXml],[template,patch],[graphTemplate,graphPatch]])assert.equal(hash(await readFile(file)),hash(original));
});
