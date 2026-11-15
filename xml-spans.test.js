import {test} from 'node:test';import assert from 'node:assert/strict';import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
test('spans preserve exact nested XML with quoted >, comments, CDATA and astral text',()=>{
 const xml='<?xml version="1.0"?><root><cue id="decoy" data-id="wanted"/><cue id="wanted" label="A > 😀"><!-- <cue/> --><![CDATA[</cue>]]><graph><node id="n1"/><node id="n2"><settings/></node></graph></cue><tail/></root>';
 const root=parseXmlSpans(xml);const [cue]=selectXmlSpans(root,['root',{name:'cue',attributes:{id:'wanted'}}]);assert.equal(xml.slice(cue.start,cue.openEnd),'<cue id="wanted" label="A > 😀">');assert.equal(xml.slice(cue.closeStart,cue.end),'</cue>');assert.match(xml.slice(cue.openEnd,cue.closeStart),/<!\[CDATA\[<\/cue>\]\]>/);
 const nodes=selectXmlSpans(root,['root',{name:'cue',attributes:{id:'wanted'}},'graph','node']);assert.equal(nodes.length,2);assert.equal(xml.slice(nodes[0].start,nodes[0].end),'<node id="n1"/>');assert.equal(nodes[0].openEnd,nodes[0].end);assert.equal(nodes[0].closeStart,nodes[0].end);assert.equal(xml.slice(nodes[1].start,nodes[1].end),'<node id="n2"><settings/></node>');
 assert.equal(selectXmlSpans(root,['root',{name:'cue',attributes:{id:'missing'}}]).length,0);assert.equal(root.end,xml.length);
});
test('rejects DTDs and malformed XML',()=>{
 assert.throws(()=>parseXmlSpans('<!DOCTYPE root><root/>'),/DOCTYPE/);assert.throws(()=>parseXmlSpans('<root><a></root>'));assert.throws(()=>parseXmlSpans('<root/><root/>'));assert.throws(()=>parseXmlSpans('<root a="<"/>'));
});
