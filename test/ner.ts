import assert from 'assert';
import { Falcon } from '../lib/ner/falcon';

const TEST_CASES = [
    ["who wrote the game of thrones theme ?", ['Q23572'], ['P800']]
];

async function main() {
    const liner = new Falcon({ ner_cache: 'falcon.sqlite', wikidata_cache: 'wikidata_cache.sqlite', bootleg: 'bootleg.sqlite' });
    for (const [utterance, expectedEntities, expectedRelations] of TEST_CASES) {
        const result = await liner.run(utterance as string);
        assert.deepStrictEqual(result.entities.map((e : any) => e.id), expectedEntities);
        assert.deepStrictEqual(result.relations.map((r : any) => r.id), expectedRelations);
    }
}

main();
