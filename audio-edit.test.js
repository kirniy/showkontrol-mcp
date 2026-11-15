import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {editTimelineAudioClipCopy,inspectTimeline,inspectShowTimeline} from './timeline.js';
const xml=`<sktimeline version="1"><audio><clip name="same" vol='old' pps="1"/><clip name="same" vol="old" pps="1"/></audio><audio><clip name="same" vol="old"/></audio></sktimeline>`;
const hash=s=>createHash('sha256').update(s).digest('hex');
const wrap=s=>`<skshow><!-- keep --><part name="content/a.sktl" md5="${createHash('md5').update(s).digest('hex')}">${Buffer.from(s).toString('base64')}</part></skshow>`;
async function setup(t){const dir=await mkdtemp(path.join(os.tmpdir(),'audio-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('edits only selected attribute spans and checks failures before output',async t=>{
 const dir=await setup(t),source=path.join(dir,'a.sktl'),destination=path.join(dir,'b.sktl');await writeFile(source,xml);
 const args={source,destination,format:'sktl',sha256:hash(xml),audioIndex:0,clipIndex:1,attributes:{vol:`a&<"'\n`}};
 await editTimelineAudioClipCopy(args);const output=await readFile(destination,'utf8');
 assert.equal(output,xml.replace('vol="old" pps="1"','vol="a&amp;&lt;&quot;&apos;&#xA;" pps="1"'));
 assert.equal((await inspectTimeline({file:destination})).audioClips[1].attributes.vol,args.attributes.vol);
 await assert.rejects(editTimelineAudioClipCopy(args));assert.equal(await readFile(destination,'utf8'),output);
 for(const [changes,pattern] of [[{sha256:'0'.repeat(64)},/changed/],[{clipIndex:9},/index/],[{attributes:{fadeInMs:'1'}},/must exist/],[{attributes:{file:'x'}},/supported/],[{attributes:{vol:'\u0000'}},/Invalid XML/]]){
  const target=path.join(dir,`failed-${Math.random()}.sktl`);await assert.rejects(editTimelineAudioClipCopy({...args,...changes,destination:target}),pattern);await assert.rejects(access(target));
 }
 const bad=path.join(dir,'bad.sktl');await writeFile(bad,'<sktimeline>');const target=path.join(dir,'bad-out.sktl');await assert.rejects(editTimelineAudioClipCopy({...args,source:bad,destination:target}));await assert.rejects(access(target));
});
test('multi-attribute edits preserve other bytes and fail together when an attribute is missing',async t=>{
 const dir=await setup(t),source=path.join(dir,'source.sktl'),destination=path.join(dir,'copy.sktl');
 await writeFile(source,xml);
 const args={source,destination,format:'sktl',sha256:hash(xml),audioIndex:0,clipIndex:0,attributes:{vol:'0.75',pps:'90 & more'}};
 await editTimelineAudioClipCopy(args);
 assert.equal(await readFile(destination,'utf8'),xml.replace("vol='old' pps=\"1\"", "vol='0.75' pps=\"90 &amp; more\""));
 const failed=path.join(dir,'failed.sktl');
 await assert.rejects(editTimelineAudioClipCopy({...args,destination:failed,attributes:{vol:'0.75',fadeInMs:'10'}}),/must exist/);
 await assert.rejects(access(failed));
 assert.equal(await readFile(source,'utf8'),xml);
});
test('MCP edits a show part and rejects duplicate part names',async t=>{
 const dir=await setup(t),source=path.join(dir,'a.skshow'),destination=path.join(dir,'b.skshow'),show=wrap(xml);await writeFile(source,show);
 const client=new Client({name:'audio-edit-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const args={source,destination,format:'skshow',sha256:hash(show),name:'content/a.sktl',audioIndex:1,clipIndex:0,attributes:{vol:'&"\t'}};
 const response=await client.callTool({name:'showkontrol_edit_timeline_audio_clip_copy',arguments:args});assert.equal(response.isError,undefined);
 const info=await inspectShowTimeline({file:destination,name:args.name});assert.equal(info.audioClips[2].attributes.vol,args.attributes.vol);assert.equal(info.audioClips[0].attributes.vol,'old');
 assert.match(await readFile(destination,'utf8'),/<!-- keep -->/);
 const dup=show.replace('</skshow>',show.match(/<part[\s\S]*<\/part>/)[0]+'</skshow>'),dupFile=path.join(dir,'dup.skshow'),out=path.join(dir,'dup-out.skshow');await writeFile(dupFile,dup);
 const failure=await client.callTool({name:'showkontrol_edit_timeline_audio_clip_copy',arguments:{...args,source:dupFile,destination:out,sha256:hash(dup)}});assert.equal(failure.isError,true);await assert.rejects(access(out));
});
test('edits the app-reserialized fixture when available',async t=>{
 const fixture='/Users/kirniy/Documents/Codex/2026-11-15/we-have-this-showkontrol-live-thing/work/MCP-audio-experiment/TIMELINE/Composed_Test.sktl';
 let text;try{text=await readFile(fixture,'utf8')}catch{t.skip('fixture not available');return;}
 const dir=await setup(t),info=await inspectTimeline({file:fixture}),clip=info.audioClips.find(c=>Object.hasOwn(c.attributes,'vol'));assert.ok(clip);
 const index=info.audioClips.filter(c=>c.audioIndex===clip.audioIndex).indexOf(clip),destination=path.join(dir,'fixture.sktl');
 await editTimelineAudioClipCopy({source:fixture,destination,format:'sktl',sha256:hash(text),audioIndex:clip.audioIndex,clipIndex:index,attributes:{vol:'0.25'}});
 assert.equal((await inspectTimeline({file:destination})).audioClips.filter(c=>c.audioIndex===clip.audioIndex)[index].attributes.vol,'0.25');
});
