import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,link,rm,chmod,realpath,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {preflightSessionAudio} from './session-audio-preflight.js';
import {inspectSessionMedia} from './session-media.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const esc=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const clip=(file,extra='')=>`<clip name="c" file="${esc(file)}" wave="" grid="" pps="315" offsetMs="0" trimStartMs="0" trimEndMs="2000" fadeInMs="0" fadeOutMs="0"${extra}/>`;
const timeline=clips=>`<sktimeline version="1" name="T"><audio name="A" follow="0">${clips.join('')}</audio></sktimeline>`;
const program=items=>`<skprogram version="1">${items.map(t=>`<item start="0" name="Item" notes="">${t}</item>`).join('')}</skprogram>`;
// PCM16 mono WAV; `declared` overrides the data chunk size to make a truncated file.
const wav=(frames,rate=8000,declared)=>{const data=Buffer.alloc(frames*2),h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+(declared??data.length),4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(declared??data.length,40);return Buffer.concat([h,data]);};
const hasFfprobe=(()=>{try{execFileSync('ffprobe',['-version'],{stdio:'ignore'});return true;}catch{return false;}})();

async function session(t,{map=[],track=[],items=[],files={}}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-audio-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'MEDIA'));await mkdir(path.join(dir,'outside'));
 for(const [name,bytes] of Object.entries(files))await writeFile(path.join(dir,name),bytes);
 const fill=s=>s.replaceAll('@',dir);
 const parts=[part('media.map',fill(map.join('\n'))),part('content/Track.sktl',fill(timeline(track)))];
 if(items.length)parts.push(part('content/Program.skpr',fill(program(items))));
 await writeFile(path.join(dir,'session.skshow'),`<skshow>${parts.join('')}</skshow>`);
 return dir;
}
async function snapshot(dir){const out={};for(const name of await readdir(dir,{recursive:true}))try{out[name]=createHash('sha256').update(await readFile(path.join(dir,name))).digest('hex');}catch{out[name]='dir';}return out;}
// A directory holding only a fake ffprobe; callers put it on PATH.
async function fakeBin(t,script){
 const bin=await mkdtemp(path.join(os.tmpdir(),'sk-fake-ffprobe-'));t.after(()=>rm(bin,{recursive:true,force:true}));
 if(script!==undefined)await writeFile(path.join(bin,'ffprobe'),'#!/bin/sh\nPATH=/usr/bin:/bin\n'+script,{mode:0o755});
 return bin;
}
function keepPath(t){const original=process.env.PATH;t.after(()=>{process.env.PATH=original;});}

test('real ffprobe: durations of opened sidecars and source paths, track and Program clips, without changing the session',{skip:!hasFfprobe&&'ffprobe is not installed'},async t=>{
 const dir=await session(t,{
  map:['/orig/a.wav\tMEDIA/a.wav','/orig/trunc.wav\tMEDIA/trunc.wav','/orig/bad.wav\tMEDIA/bad.wav','/orig/gone.wav\tMEDIA/gone.wav','/orig/list.wav\tMEDIA/list.m3u8','/orig/manifest.wav\tMEDIA/manifest.wav'],
  track:[clip('/orig/a.wav'),clip('/orig/trunc.wav'),clip('/orig/bad.wav'),clip('/orig/gone.wav'),clip('@/outside/src.wav'),clip('/orig/list.wav'),clip('/orig/manifest.wav')],
  items:[timeline([clip('/orig/a.wav')]),''],
  files:{'MEDIA/a.wav':wav(12000),'MEDIA/trunc.wav':wav(4000,8000,80000),'MEDIA/bad.wav':'not audio','outside/src.wav':wav(6615,44100),
   'MEDIA/list.m3u8':'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.5,\na.wav\n#EXT-X-ENDLIST\n'}
 });
 // A DASH manifest is detected by content; allowing the file protocol would let ffprobe open the segment and report its duration.
 await writeFile(path.join(dir,'outside','seg.mp4'),wav(8000));
 await writeFile(path.join(dir,'MEDIA','manifest.wav'),`<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet mimeType="audio/wav"><Representation id="1" bandwidth="128000"><BaseURL>file:${dir}/outside/seg.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`);
 const before=await snapshot(dir),{showSha256}=await inspectSessionMedia({directory:dir});
 const r=await preflightSessionAudio({directory:dir,sha256:showSha256});
 assert.deepEqual(await snapshot(dir),before);
 assert.equal(r.probe.ffprobe,'ran');
 const fileOf=c=>r.files[(c.sidecar.fileIndex??c.sourcePath.fileIndex)];
 const [a,trunc,bad,gone,outside,list,manifest,programA]=r.clips;
 // Expected durations come from the sample counts written above, not from ffprobe.
 assert.equal(fileOf(a).duration.status,'known');assert.equal(fileOf(a).duration.seconds,12000/8000);
 assert.deepEqual(fileOf(a).duration.audioStreams,[{index:0,seconds:1.5}]);assert.equal(fileOf(a).duration.formatName,'wav');
 assert.equal(fileOf(a).duration.estimatedFromBitrate,false);
 assert.deepEqual({part:programA.part,itemIndex:programA.itemIndex,fileIndex:programA.sidecar.fileIndex},{part:'content/Program.skpr',itemIndex:0,fileIndex:a.sidecar.fileIndex});
 assert.equal(fileOf(a).clipCount,2);
 assert.equal(fileOf(trunc).duration.seconds,0.5);assert.equal(fileOf(trunc).duration.estimatedFromBitrate,true);
 assert.deepEqual([fileOf(bad).status,fileOf(bad).duration.status,fileOf(bad).duration.reason],['readable','unknown','ffprobe_failed']);
 assert.deepEqual(gone.sidecar,{line:4,archivePath:'MEDIA/gone.wav',status:'missing'});
 assert.deepEqual({status:gone.sourcePath.status},{status:'not_found_at_checked_path'});
 assert.equal(outside.sidecar.status,'unmapped');assert.equal(outside.sourcePath.status,'readable');
 assert.equal(fileOf(outside).duration.seconds,6615/44100);
 // A playlist sidecar must not make ffprobe open the file it names.
 assert.equal(fileOf(list).duration.status,'unknown');
 assert.deepEqual([fileOf(manifest).duration.status,fileOf(manifest).duration.reason],['unknown','ffprobe_failed']);
 assert.deepEqual(a.observedTrim,{trimStartMs:'0',trimEndMs:'2000'});
 assert.equal(r.trimComparison.status,'not_established');
 // No field may carry a trim or playback verdict.
 const keys=[];JSON.stringify(r,(k,v)=>{keys.push(k);return v;});
 assert.deepEqual(keys.filter(k=>/exceed|fit|safe|playable|valid/i.test(k)),[]);
 assert.deepEqual(r.files.map(f=>f.fileIndex),r.files.map((_,i)=>i));
 await assert.rejects(preflightSessionAudio({directory:dir,sha256:'0'.repeat(64)}),/changed since inspection/);
});

test('candidates: unmapped, ambiguous, symlinked, special, unreadable, relative and empty files; hard links merge',async t=>{
 const countScript='printf x >> "$COUNT"; printf \'{"format":{"duration":"%s"}}\' "$(wc -c <&3 | tr -d " ")"\n';
 const dir=await session(t,{
  map:['/dup\tMEDIA/one.wav','/dup\tMEDIA/two.wav','/link\tMEDIA/link.wav','@/outside/hard-src.wav\tMEDIA/hard.wav','/locked\tMEDIA/locked.wav','/fifo\tMEDIA/fifo.wav','/dir\tMEDIA/sub'],
  track:[clip('/dup'),clip('/link'),clip('@/outside/hard-src.wav'),clip('/locked'),clip('/fifo'),clip('/dir'),clip('MEDIA/one.wav'),clip(''),'<clip name="nofile" trimEndMs="1e309"/>',
   clip('@/outside/link-to-src.wav'),clip('@/outside/fifo'),clip('@/outside/hard-src.wav'),clip('/x').replace('trimEndMs="2000"',`trimEndMs="${'9'.repeat(300)}"`)],
  files:{'MEDIA/one.wav':'1','MEDIA/two.wav':'22','outside/hard-src.wav':'hard!','MEDIA/locked.wav':'locked'}
 });
 process.env.COUNT=path.join(dir,'..',path.basename(dir)+'-count');t.after(()=>{rm(process.env.COUNT,{force:true});delete process.env.COUNT;});
 await symlink(path.join(dir,'MEDIA','one.wav'),path.join(dir,'MEDIA','link.wav'));
 await link(path.join(dir,'outside','hard-src.wav'),path.join(dir,'MEDIA','hard.wav'));
 await symlink(path.join(dir,'outside','hard-src.wav'),path.join(dir,'outside','link-to-src.wav'));
 execFileSync('mkfifo',[path.join(dir,'MEDIA','fifo.wav')]);execFileSync('mkfifo',[path.join(dir,'outside','fifo')]);
 await mkdir(path.join(dir,'MEDIA','sub'));
 await chmod(path.join(dir,'MEDIA','locked.wav'),0);
 keepPath(t);process.env.PATH=await fakeBin(t,countScript);
 const asRoot=process.getuid?.()===0;
 const r=await preflightSessionAudio({directory:dir});
 const [dup,lnk,hard,locked,fifo,sub,relative,empty,nofile,viaLink,srcFifo,hardAgain,long]=r.clips;
 assert.deepEqual(dup.sidecar,{status:'ambiguous_mapping',ambiguousLines:[1,2]});
 assert.equal(lnk.sidecar.status,'symlink');
 assert.equal(hard.sidecar.status,'readable');assert.equal(hard.sourcePath.fileIndex,hard.sidecar.fileIndex);
 const merged=r.files[hard.sidecar.fileIndex];
 // Sidecars are found below the resolved session directory (macOS temporary directories under /var resolve to /private/var); source paths are reported as written.
 assert.equal(r.directory,await realpath(dir));
 assert.deepEqual(merged.paths,[
  {kind:'sidecar',line:4,archivePath:'MEDIA/hard.wav',path:path.join(r.directory,'MEDIA','hard.wav')},
  {kind:'source_path',path:path.join(dir,'outside','hard-src.wav')},
  {kind:'source_path',path:path.join(dir,'outside','link-to-src.wav')}]);
 // The mock reports the byte count it read from the passed descriptor.
 assert.equal(merged.duration.seconds,5);
 assert.equal(viaLink.sourcePath.viaSymlink,true);assert.equal(viaLink.sourcePath.fileIndex,merged.fileIndex);assert.equal(hardAgain.sourcePath.fileIndex,merged.fileIndex);
 assert.equal(merged.clipCount,3);
 if(!asRoot){assert.equal(locked.sidecar.status,'not_readable');assert.equal(locked.sidecar.errorCode,'EACCES');assert.equal(r.files[locked.sidecar.fileIndex].duration.status,'not_checked');}
 assert.equal(fifo.sidecar.status,'not_regular_file');assert.equal(srcFifo.sourcePath.status,'not_regular_file');
 assert.equal(sub.sidecar.status,'not_regular_file');
 assert.equal(relative.sourcePath.status,'not_absolute');assert.equal(empty.sourcePath.status,'empty');
 assert.deepEqual([nofile.sourcePath.status,nofile.file,nofile.observedTrim],['no_file_attribute',null,{trimStartMs:null,trimEndMs:'1e309'}]);
 assert.deepEqual(long.observedTrim.trimEndMs,{length:300,valueOmitted:true});
 assert.equal((await readFile(process.env.COUNT,'utf8')).length,r.files.filter(f=>f.status==='readable').length);
 assert.ok(r.diagnostics.some(d=>d.code==='duplicate_source'));
 // Only the hard-linked file opens for every candidate path that reaches it; the locked sidecar opens as root.
 assert.equal(r.summary.clips,13);
 assert.deepEqual(r.summary.withoutReadableMedia.map(c=>c.clipIndex),[0,1,...(asRoot?[]:[3]),4,5,6,7,8,10,12]);
 assert.deepEqual(r.summary.withoutReadableMedia[0],{part:dup.part,audioIndex:0,clipIndex:0});
 // Readability is checked by opening even when probing is off.
 const off=await preflightSessionAudio({directory:dir,probeDurations:false});
 if(!asRoot)assert.equal(off.clips[3].sidecar.status,'not_readable');
 assert.equal(off.clips[2].sidecar.status,'readable');
});

test('ffprobe failures stay unknown or unavailable, and the shared budget bounds runtime',async t=>{
 const dir=await session(t,{map:['/a\tMEDIA/a.wav','/b\tMEDIA/b.wav','/c\tMEDIA/c.wav','/d\tMEDIA/d.wav','/e\tMEDIA/e.wav','/f\tMEDIA/$(touch injected).wav'],
  track:['/a','/b','/c','/d','/e','/f'].map(f=>clip(f)),files:{'MEDIA/a.wav':'a','MEDIA/b.wav':'bb','MEDIA/c.wav':'ccc','MEDIA/d.wav':'dddd','MEDIA/e.wav':'eeeee','MEDIA/$(touch injected).wav':'ffffff'}});
 keepPath(t);process.env.PATH=await fakeBin(t,`n=$(wc -c <&3 | tr -d " ")
case $n in
1) printf '{"format":{"duration":"N/A"},"streams":[{"index":0,"codec_type":"audio","duration":"-1"}]}';;
2) printf 'not json';;
3) echo "Unrecognized option 'fd'." >&2; exit 1;;
4) head -c 200000 /dev/zero;;
5) printf '{"format":{"duration":"1e3"}}';;
*) printf '{"format":{"duration":"2.5","format_name":"wav"}}';;
esac
`);
 const r=await preflightSessionAudio({directory:dir});
 assert.deepEqual(r.clips.map(c=>{const d=r.files[c.sidecar.fileIndex].duration;return [d.status,d.reason??d.seconds];}),[
  ['unknown','no_container_duration'],['unknown','invalid_output'],['unknown','fd_input_unsupported'],['unknown','output_too_large'],['unknown','no_container_duration'],['known',2.5]]);
 assert.deepEqual(r.files[0].duration.audioStreams,[{index:0,seconds:null}]);
 await assert.rejects(readFile(path.join(dir,'MEDIA','injected')),{code:'ENOENT'});
 await assert.rejects(readFile(path.join(dir,'injected')),{code:'ENOENT'});

 process.env.PATH=await fakeBin(t,'exec /bin/sleep 30\n');
 const started=performance.now();
 const slow=await preflightSessionAudio({directory:dir,probeBudgetMs:300});
 const elapsed=performance.now()-started;
 assert.ok(elapsed<5000,`took ${elapsed} ms`);
 const statuses=slow.files.map(f=>f.duration.reason);
 assert.ok(statuses.includes('timeout'));assert.ok(statuses.includes('budget_exhausted'));
 assert.ok(statuses.every(s=>s==='timeout'||s==='budget_exhausted'));

 process.env.PATH=await fakeBin(t);
 const none=await preflightSessionAudio({directory:dir});
 assert.equal(none.probe.ffprobe,'unavailable');assert.ok(none.files.every(f=>f.status==='readable'&&f.duration.status==='unavailable'));
 const off=await preflightSessionAudio({directory:dir,probeDurations:false});
 assert.equal(off.probe.ffprobe,'disabled');assert.ok(off.files.every(f=>f.status==='readable'&&f.duration.status==='disabled'));
});

test('input validation and distinct path limit',async t=>{
 const dir=await session(t,{track:[clip('/a')]});
 await assert.rejects(preflightSessionAudio({directory:'relative'}),/absolute/);
 await assert.rejects(preflightSessionAudio({directory:dir,probeBudgetMs:50}),/probeBudgetMs/);
 await assert.rejects(preflightSessionAudio({directory:dir,probeDurations:'yes'}),/boolean/);
 await assert.rejects(preflightSessionAudio({directory:dir,sha256:'ABC'}),/sha256/);
 const many=await session(t,{track:Array.from({length:1001},(_,i)=>clip(`/m/${i}.wav`))});
 await assert.rejects(preflightSessionAudio({directory:many,probeDurations:false}),/1000 distinct media paths/);
 const ok=await session(t,{track:Array.from({length:1000},(_,i)=>clip(`/m/${i}.wav`))});
 assert.equal((await preflightSessionAudio({directory:ok,probeDurations:false})).clips.length,1000);
});

test('MCP exposes the read-only session audio preflight',async t=>{
 const dir=await session(t,{map:['/a\tMEDIA/a.wav'],track:[clip('/a')],files:{'MEDIA/a.wav':wav(800)}});
 const client=new Client({name:'session-audio-preflight-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tool=(await client.listTools()).tools.find(x=>x.name==='showkontrol_preflight_session_audio');
 assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
 const response=await client.callTool({name:tool.name,arguments:{directory:dir,probeDurations:false}});
 assert.equal(response.isError,undefined,JSON.stringify(response));
 const r=JSON.parse(response.content[0].text);
 assert.deepEqual([r.clips[0].sidecar.status,r.files[0].duration.status,r.trimComparison.status],['readable','disabled','not_established']);
 const bad=await client.callTool({name:tool.name,arguments:{directory:dir,probeBudgetMs:1}});
 assert.equal(bad.isError,true);
});

test('a sidecar replaced after staging is reported as changed and is not probed',async t=>{
 // Four probes run at once; the first (1-byte file) swaps the two files that are opened later, the others wait.
 const dir=await session(t,{map:['/a\tMEDIA/a.wav','/b\tMEDIA/b.wav','/c\tMEDIA/c.wav','/d\tMEDIA/d.wav','/e\tMEDIA/e.wav','/f\tMEDIA/f.wav'],
  track:['/a','/b','/c','/d','/e','/f'].map(f=>clip(f)),files:{'MEDIA/a.wav':'a','MEDIA/b.wav':'bb','MEDIA/c.wav':'ccc','MEDIA/d.wav':'dddd','MEDIA/e.wav':'eeeee','MEDIA/f.wav':'ffffff','outside/other.wav':'other'}});
 keepPath(t);process.env.PATH=await fakeBin(t,`n=$(wc -c <&3 | tr -d " ")
if [ "$n" = 1 ]; then ln -sf "$SESSION/outside/other.wav" "$SESSION/MEDIA/e.wav"; printf new > "$SESSION/new"; mv "$SESSION/new" "$SESSION/MEDIA/f.wav"; else sleep 0.3; fi
printf '{"format":{"duration":"%s"}}' "$n"
`);
 process.env.SESSION=dir;t.after(()=>{delete process.env.SESSION;});
 const r=await preflightSessionAudio({directory:dir});
 assert.deepEqual(r.files.map(f=>[f.status,f.duration.status]),[['readable','known'],['readable','known'],['readable','known'],['readable','known'],['changed_during_check','not_checked'],['changed_during_check','not_checked']]);
 assert.deepEqual(r.clips.slice(4).map(c=>c.sidecar.status),['changed_during_check','changed_during_check']);
});

test('a session reached through a symlinked directory is resolved once; symlinks inside it are still refused',async t=>{
 // Reproduces the macOS /var -> /private/var case on any platform.
 const dir=await session(t,{map:['/a\tMEDIA/a.wav','/b\tMEDIA/b.wav'],track:[clip('/a'),clip('/b'),clip('@/outside/src.wav')],files:{'MEDIA/a.wav':'a','outside/src.wav':'src','outside/b.wav':'b'}});
 await symlink(path.join(dir,'outside','b.wav'),path.join(dir,'MEDIA','b.wav'));
 const alias=await mkdtemp(path.join(os.tmpdir(),'sk-audio-alias-'));t.after(()=>rm(alias,{recursive:true,force:true}));
 const via=path.join(alias,'session');await symlink(dir,via);
 const real=await realpath(dir);
 const r=await preflightSessionAudio({directory:via,probeDurations:false});
 assert.equal(r.directory,real);
 const [a,b,src]=r.clips;
 assert.equal(a.sidecar.status,'readable');
 assert.deepEqual(r.files[a.sidecar.fileIndex].paths,[{kind:'sidecar',line:1,archivePath:'MEDIA/a.wav',path:path.join(real,'MEDIA','a.wav')}]);
 assert.equal(b.sidecar.status,'symlink');assert.equal(b.sidecar.fileIndex,undefined);
 assert.deepEqual(r.files[src.sourcePath.fileIndex].paths,[{kind:'source_path',path:path.join(dir,'outside','src.wav')}]);
 // A symlinked MEDIA directory is refused for every sidecar, even though the session itself was reached through a symlink.
 await rename(path.join(dir,'MEDIA'),path.join(dir,'real-media'));await symlink(path.join(dir,'real-media'),path.join(dir,'MEDIA'));
 const swapped=await preflightSessionAudio({directory:via,probeDurations:false});
 assert.deepEqual(swapped.clips.slice(0,2).map(c=>c.sidecar.status),['symlink','symlink']);
 assert.equal(swapped.files.length,1);
});
