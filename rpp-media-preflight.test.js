import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, symlink, rm, readFile, stat, chmod} from 'node:fs/promises';
import {openSync, closeSync, constants as fsConstants} from 'node:fs';
import {execFile, execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {preflightRppMedia} from './rpp.js';

const item = file => ({file, seconds:0, duration:1});
const track = items => ({name:'音声',kind:'audio',items});

test('preflight checks exact paths, symlinks and duplicates without writing', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-preflight-'));
 t.after(() => rm(dir,{recursive:true,force:true}));
 const media = path.join(dir,'音 声.wav');
 await writeFile(media,'original');
 await mkdir(path.join(dir,'directory.wav'));
 await symlink(media,path.join(dir,'link.wav'));
 await symlink(path.join(dir,'absent.wav'),path.join(dir,'broken.wav'));
 const file = path.join(dir,'future.rpp');
 const result = await preflightRppMedia({file,mediaTracks:[track(['音 声.wav',media,'link.wav','broken.wav','directory.wav','missing.wav'].map(item))]});
 assert.deepEqual(result.findings.map(x=>x.status),['readable','readable','readable','not_found_at_checked_path','not_regular_file','not_found_at_checked_path']);
 assert.equal(result.findings[0].checkedPath,media);
 assert.deepEqual(result.findings.map(x=>x.itemIndex),[0,1,2,3,4,5]);
 assert.match(result.limitations.join(' '),/additional locations/);
 await assert.rejects(() => import('node:fs/promises').then(fs=>fs.stat(file)),{code:'ENOENT'});
 assert.equal(await import('node:fs/promises').then(fs=>fs.readFile(media,'utf8')),'original');
});

test('preflight shares render validation and applies bounds', async () => {
 const file = '/tmp/future.rpp';
 await assert.rejects(preflightRppMedia({file,mediaTracks:[track([item('bad.ogg')])]}),/Audio source/);
 await assert.rejects(preflightRppMedia({file,mediaTracks:[track([{...item('ok.wav'),fadeIn:2}])]}),/Fade durations/);
 await assert.rejects(preflightRppMedia({file:'relative.rpp',mediaTracks:[track([item('ok.wav')])]}),/absolute path/);
 await assert.rejects(preflightRppMedia({file,mediaTracks:[track(Array.from({length:501},()=>item('ok.wav')))]}),/500/);
});

test('preflight preserves symlink traversal before parent components', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-preflight-symlink-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'target','nested'),{recursive:true});
 await writeFile(path.join(dir,'target','sound.wav'),'x');
 await symlink(path.join(dir,'target','nested'),path.join(dir,'link'));
 const relative = 'link/../sound.wav';
 const absolute = path.join(dir,'link') + '/../sound.wav';
 const result = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track([item(relative),item(absolute)])]});
 assert.deepEqual(result.findings.map(x=>x.status),['readable','readable']);
 assert.deepEqual(result.findings.map(x=>x.checkedPath),[dir + '/' + relative,absolute]);
});

test('MCP exposes the read-only preflight and returns per-item results', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-preflight-mcp-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'test.wav'),'x');
 const client = new Client({name:'rpp-preflight-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));
 t.after(()=>client.close());
 const tool = (await client.listTools()).tools.find(x=>x.name==='showkontrol_preflight_rpp_media');
 assert.equal(tool.annotations.readOnlyHint,true);
 const result = await client.callTool({name:tool.name,arguments:{file:path.join(dir,'test.rpp'),mediaTracks:[track([item('test.wav'),item('missing.wav')])]}});
 assert.equal(result.isError,undefined,JSON.stringify(result));
 assert.deepEqual(JSON.parse(result.content[0].text).findings.map(x=>x.status),['readable','not_found_at_checked_path']);
});

// Fake probes read the first line of descriptor 3 with shell builtins, so the result proves which file was passed.
const fakeProbe = async (dir, body) => {
 const bin = path.join(dir,'bin');
 await mkdir(bin,{recursive:true});
 await writeFile(path.join(bin,'ffprobe'), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > "$PROBE_ARGS_FILE"\nIFS= read -r content <&3\n${body}\n`, {mode:0o755});
 return bin;
};
const withEnv = (t, values) => {
 const old = Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 t.after(()=>{ for (const [key,value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
 Object.assign(process.env, values);
};
const EXPECTED_ARGS = ['-v','error','-protocol_whitelist','fd','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1','-fd','3','-i','fd:'];

test('optional duration probe reads the opened file through descriptor 3 and reports reasons', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-probe-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const bin = await fakeProbe(dir, [
  'case "$content" in',
  ' invalid) printf "N/A\\n";;',
  ' failure) exit 1;;',
  ` old-option) printf "Failed to set value '3' for option 'fd': Option not found\\n" >&2; exit 1;;`,
  ' old-protocol) printf "fd:: Protocol not found\\n" >&2; exit 1;;',
  ' nested) printf "[dash @ 0x1] fd:: Protocol not found\\n" >&2; exit 1;;',
  ' large) i=0; while [ $i -lt 2000 ]; do printf "0123456789"; i=$((i+1)); done;;',
  ' *) printf "%s\\n" "$content";;',
  'esac'
 ].join('\n'));
 const files = {'normal.wav':'10.5','invalid.wav':'invalid','failure.wav':'failure','$(touch injected).wav':'3','old-option.wav':'old-option','old-protocol.wav':'old-protocol','nested.wav':'nested','large.wav':'large'};
 for (const [name,content] of Object.entries(files)) await writeFile(path.join(dir,name),content + '\n');
 withEnv(t,{PATH:bin,PROBE_ARGS_FILE:path.join(dir,'args')});
 const names = Object.keys(files);
 const inputs = [ {...item(names[0]),sourceOffset:9,duration:2}, {...item(names[0]),sourceOffset:9,duration:1.5}, ...names.slice(1).map(item), item('missing.wav') ];
 const result = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track(inputs)],probeDurations:true});
 assert.deepEqual(result.findings.map(x=>x.duration), [
  {status:'known',seconds:10.5,exceedsSource:true}, {status:'known',seconds:10.5,exceedsSource:false},
  {status:'unknown',reason:'no_duration'}, {status:'unknown',reason:'ffprobe_failed'}, {status:'known',seconds:3,exceedsSource:false},
  {status:'unknown',reason:'fd_input_unsupported'}, {status:'unknown',reason:'fd_input_unsupported'}, {status:'unknown',reason:'ffprobe_failed'},
  {status:'unknown',reason:'output_too_large'}, {status:'not_checked'}
 ]);
 // No path reaches the command line; the last probe saw exactly the fixed arguments.
 assert.deepEqual((await readFile(process.env.PROBE_ARGS_FILE,'utf8')).split('\n').slice(0,-1), EXPECTED_ARGS);
 await assert.rejects(stat(path.join(dir,'injected')),{code:'ENOENT'});
 await rm(path.join(bin,'ffprobe'));
 const unavailable = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track([item(names[0])])],probeDurations:true});
 assert.deepEqual(unavailable.findings[0].duration,{status:'unavailable'});
 const disabled = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track([item(names[0])])]});
 assert.deepEqual(disabled.findings[0].duration,{status:'disabled'});
});

test('duration probes reuse one file reached by several paths and stop the process group after the budget', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-probe-budget-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 // `slow` forks a child that would keep running and keep the pipes open if only the script were killed.
 const bin = await fakeProbe(dir, 'case "$content" in slow) /bin/sleep 30 & printf "%s" "$!" > "$PROBE_CHILD_FILE"; wait; exit 0;; esac\nprintf x >> "$PROBE_COUNT_FILE"\nprintf "2\\n"');
 for (const name of ['same.wav','slow.wav','later.wav']) await writeFile(path.join(dir,name),name.slice(0,-4) + '\n');
 await symlink(path.join(dir,'same.wav'),path.join(dir,'alias.wav'));
 withEnv(t,{PATH:bin,PROBE_ARGS_FILE:path.join(dir,'args'),PROBE_COUNT_FILE:path.join(dir,'count'),PROBE_CHILD_FILE:path.join(dir,'child')});
 const started = performance.now();
 const result = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track([item('same.wav'),{...item('same.wav'),duration:3},item('alias.wav'),item(path.join(dir,'same.wav')),item('slow.wav'),item('later.wav')])],probeDurations:true});
 const elapsed = performance.now() - started;
 assert.deepEqual(result.findings.map(x=>x.duration),[
  {status:'known',seconds:2,exceedsSource:false}, {status:'known',seconds:2,exceedsSource:true}, {status:'known',seconds:2,exceedsSource:false}, {status:'known',seconds:2,exceedsSource:false},
  {status:'unknown',reason:'timeout'}, {status:'not_checked'}
 ]);
 assert.ok(elapsed < 7000, `preflight took ${elapsed} ms`);
 assert.equal(await readFile(process.env.PROBE_COUNT_FILE,'utf8'),'x');
 const child = Number(await readFile(process.env.PROBE_CHILD_FILE,'utf8'));
 let alive = true;
 for (let i = 0; alive && i < 50; i++) { try { process.kill(child,0); await new Promise(r=>setTimeout(r,20)); } catch (error) { assert.equal(error.code,'ESRCH'); alive = false; } }
 assert.equal(alive,false,'forked probe child survived the timeout');
});

test('readability comes from opening the file; FIFOs are not opened and unreadable files fail the check', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-preflight-open-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('mkfifo',[path.join(dir,'pipe.wav')]);
 await writeFile(path.join(dir,'locked.wav'),'x');
 await chmod(path.join(dir,'locked.wav'),0o000);
 await writeFile(path.join(dir,'ok.wav'),'x');
 // A directory reached through a symlink, as /var is on macOS: the checked path is reported as written.
 await symlink(dir,path.join(dir,'alias'));
 const result = await preflightRppMedia({file:path.join(dir,'alias','project.rpp'),mediaTracks:[track(['pipe.wav','locked.wav','ok.wav'].map(item))]});
 assert.equal(result.findings[0].status,'not_regular_file');
 assert.equal(result.findings[2].status,'readable');
 assert.equal(result.findings[2].checkedPath,path.join(dir,'alias','ok.wav'));
 if (process.getuid?.() === 0) t.diagnostic('running as root: permission check not exercised');
 else assert.deepEqual([result.findings[1].status,result.findings[1].errorCode],['check_failed','EACCES']);
});

// Real ffprobe: a local manifest or playlist must not make ffprobe open another file.
const realProbe = (() => {
 try { return /^fd AVOptions:/m.test(execFileSync('ffprobe',['-hide_banner','-h','protocol=fd'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000})); }
 catch { return false; }
})();
const wav = seconds => {
 const rate = 8000, n = seconds * rate, b = Buffer.alloc(44 + n, 128);
 b.write('RIFF',0); b.writeUInt32LE(36 + n,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
 b.writeUInt32LE(rate,24); b.writeUInt32LE(rate,28); b.writeUInt16LE(1,32); b.writeUInt16LE(8,34); b.write('data',36); b.writeUInt32LE(n,40);
 return b;
};
// A FIFO with no writer: opening it for writing without blocking succeeds only while someone has it open for reading.
const watchFifo = file => {
 let opened = false;
 const timer = setInterval(() => { try { closeSync(openSync(file, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); opened = true; } catch (error) { if (error.code !== 'ENXIO') throw error; } }, 2);
 return () => { clearInterval(timer); return opened; };
};
const mpd = ref => `<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT42S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="64000"><BaseURL>${ref}</BaseURL></Representation></AdaptationSet></Period></MPD>\n`;
const hls = ref => `#EXTM3U\n#EXT-X-TARGETDURATION:42\n#EXTINF:42,\n${ref}\n#EXT-X-ENDLIST\n`;
const ffconcat = ref => `ffconcat version 1.0\nfile ${ref}\n`;

test('real ffprobe reads WAV duration through the descriptor', {skip:!realProbe && 'ffprobe with the fd protocol is not installed'}, async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-real-probe-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'two.wav'),wav(2));
 await symlink(path.join(dir,'two.wav'),path.join(dir,'link.wav'));
 const result = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:[track([{...item('two.wav'),duration:1.5},{...item('link.wav'),duration:3}])],probeDurations:true});
 assert.deepEqual(result.findings.map(x=>x.duration),[{status:'known',seconds:2,exceedsSource:false},{status:'known',seconds:2,exceedsSource:true}]);
});

test('real ffprobe does not open media named by a local manifest or playlist', {skip:!realProbe && 'ffprobe with the fd protocol is not installed'}, async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'rpp-real-nested-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const cases = [];
 for (const [kind,name,build] of [['audio','dash.wav',mpd],['video','hls.m3u8',hls],['audio','concat.flac',ffconcat]]) for (const form of ['relative','absolute','file_url']) {
  const segment = `${name}-${form}.m4a`;
  execFileSync('mkfifo',[path.join(dir,segment)]);
  const ref = form === 'relative' ? segment : form === 'absolute' ? path.join(dir,segment) : 'file:' + path.join(dir,segment);
  const manifest = `${form}-${name}`;
  await writeFile(path.join(dir,manifest),build(ref));
  cases.push({kind,manifest,segment});
 }
 // Control: the former path-based probe with the `file` protocol allowed opens at least one named segment.
 let controlOpened = 0;
 for (const c of cases) {
  const stop = watchFifo(path.join(dir,c.segment));
  await new Promise(resolve => execFile('ffprobe',['-v','error','-protocol_whitelist','file','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1','-i',path.join(dir,c.manifest)],{timeout:4000},()=>resolve()));
  if (stop()) controlOpened++;
 }
 assert.ok(controlOpened > 0,'the FIFO detector saw no nested open even with the file protocol allowed');
 t.diagnostic(`path-based control opened ${controlOpened} of ${cases.length} named segments`);
 const watchers = cases.map(c=>watchFifo(path.join(dir,c.segment)));
 const result = await preflightRppMedia({file:path.join(dir,'project.rpp'),mediaTracks:['audio','video'].map(kind=>({name:kind,kind,items:cases.filter(c=>c.kind===kind).map(c=>item(c.manifest))})),probeDurations:true});
 const opened = watchers.map(stop=>stop());
 assert.deepEqual(opened, cases.map(()=>false));
 for (const finding of result.findings) {
  assert.equal(finding.status,'readable');
  assert.notEqual(finding.duration.status,'known',JSON.stringify(finding));
 }
});
