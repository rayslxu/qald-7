import assert from 'assert';
import { WikidataUtils } from '../lib';
import { Falcon } from '../lib/ner/falcon';

const TEST_CASES = [
    ["1", "who wrote the game of thrones theme ?", ['Q23572'], ['P800']]
];

async function main() {
    const wikidata = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const liner = new Falcon(wikidata, { ner_cache: 'falcon.sqlite' });
    for (const [id, utterance, expectedEntities, expectedRelations] of TEST_CASES) {
        const result = await liner.run(id as string, utterance as string);
        assert.deepStrictEqual(result.entities.map((e : any) => e.id), expectedEntities);
        assert.deepStrictEqual(result.relations.map((r : any) => r.id), expectedRelations);
    }
}

main();
