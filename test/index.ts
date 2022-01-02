import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import * as ThingTalk from 'thingtalk';

import SPARQLToThingTalkConverter from '../lib/converter';

async function main() {
    const manifest = await pfs.readFile('./manifest.tt', { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: undefined, timezone: undefined });
    assert(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef);
    const tests = fs.readFileSync('./test/tests.txt').toString('utf-8').split('====');

    for (let i = 0; i < tests.length; i++) {
        const sparql = tests[i].slice('SPARQL:'.length, tests[i].indexOf('TT:')).trim();
        const thingtalk = tests[i].slice(tests[i].indexOf('TT: ') + 'TT:'.length).trim();     
        const converted = await converter.convert(sparql);

        console.log(converted.prettyprint());
        assert.strictEqual(thingtalk, converted.prettyprint());
    }
}

main();