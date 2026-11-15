import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {readShowSnapshot} from './xml-copy.js';
import {copyCueGraphBetweenTimelines,copyCueGraphBetweenTimelinesWithShow,inspectTimeline,inspectCueGraph} from './timeline.js';

test('timeline graph composition validates router targets against the destination snapshot',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'router-snapshot-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'target.sktl'),template=path.join(dir,'donor.sktl'),show=path.join(dir,'target.skshow'),destination=path.join(dir,'out.sktl');
 const target='<sktimeline version="1"><cue id="t"/></sktimeline>';
 const donor='<sktimeline version="1"><cue id="s"><graph><node id="n1" type="action"><settings><setting key="route.router_target">A</setting></settings></node></graph></cue></sktimeline>';
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
 const patch=nodes=>`<showkontrol version="2"><graph>${nodes}</graph></showkontrol>`;
 await writeFile(source,target);await writeFile(template,donor);
 const args={source,template,destination,sha256:(await inspectTimeline({file:source})).sha256,templateSha256:(await inspectTimeline({file:template})).sha256,sourceCueId:'s',targetCueId:'t'};
 const snapshot=async content=>{await writeFile(show,content);return readShowSnapshot({file:show});};
 const wrap=content=>`<skshow>${content}</skshow>`;
 const valid=await snapshot(wrap(part('patch.skf',patch(router('n5','A')))));
 await assert.rejects(copyCueGraphBetweenTimelines(args),/router target/i);
 // Supplying an extra argument to the standalone API must not bypass its guard.
 await assert.rejects(copyCueGraphBetweenTimelines({...args,targetShow:valid}),/router target/i);
 for(const content of [part('other',target),part('patch.skf',patch('')),part('patch.skf',patch(router('n5','A')+router('n6','A'))),part('patch.skf',patch(router('bad','A'))),part('patch.skf',patch(router('n5','A')))+part('patch.skf',patch(router('n6','A')))]){
  await assert.rejects(copyCueGraphBetweenTimelinesWithShow(args,await snapshot(wrap(content))));
  await assert.rejects(readFile(destination),{code:'ENOENT'});
 }
 await assert.rejects(copyCueGraphBetweenTimelinesWithShow(args,{parts:[{...valid.parts[0],bytes:Buffer.from('tampered')}]}),/validated destination show snapshot/);
 await copyCueGraphBetweenTimelinesWithShow(args,valid);
 const graph=(await inspectCueGraph({file:destination,format:'sktl',cueId:'t'})).graph;
 assert.equal(graph.nodes[0].settings[0].value,'A');
});
