import {test} from 'node:test';import assert from 'node:assert/strict';import {hasXmlReference} from './xml-references.js';
test('reference detection separates sibling settings but joins text within one setting',()=>{
 const pattern=/(^|[^A-Za-z0-9_])n2([^A-Za-z0-9_]|$)/;
 assert.equal(hasXmlReference('<settings><setting key="a">n</setting><setting key="b">2</setting></settings>',pattern),false);
 assert.equal(hasXmlReference('<settings><setting key="a">n<![CDATA[2]]></setting></settings>',pattern),true);
 assert.equal(hasXmlReference('<settings><setting key="a">n<em>2</em></setting></settings>',pattern),true);
 assert.equal(hasXmlReference('<settings><setting key="a">n<em></em><em>2</em></setting></settings>',pattern),true);
});
