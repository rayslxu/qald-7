import assert from 'assert';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { PostProcessor } from '../lib/post-processor';

const TEST_CASES = [
    [
        'how many countries are there in europe ?',
        'count ( @org.wikidata . country ( ) filter contains ( continent , " Q46 " ^^org.wikidata:p_continent ) ) ;',
        'count ( @org.wikidata . country ( ) filter contains ( continent , " Q46 " ^^org.wikidata:p_continent ) ) ;'
    ]
];

async function main() { 
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const processor = new PostProcessor({ tpClient, schemas, includeEntityValue: true, excludeEntityDisplay: true });
    for (const [utterance, before, after] of TEST_CASES) {
        const processed = await processor.postprocess(before, utterance);
        assert.strictEqual(processed.join(' '), after);
    }
}

main();