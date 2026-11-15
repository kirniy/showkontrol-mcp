import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, symlink, rm} from 'node:fs/promises';
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
