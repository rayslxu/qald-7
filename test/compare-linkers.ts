import assert from 'assert';
import { WikidataUtils } from '../lib';
import { GPT3Linker } from '../lib/ner/gpt3';
import { Falcon } from '../lib/ner/falcon';
// import { AzureEntityLinker } from '../lib/ner/azure';

const TEST_CASES = [
    ["1", "show me museums named after louvre palace", ['Q1075988', 'Q207694'], []],
    ["2", "Which countries have more than two official languages?", [], []],
    ["3", "What is the highest mountain in Australia?", ["Q3960"], []],
    ["4", "Give me all cities in New Jersey with more than 10000 inhabitants.", ['Q1408'], []],
    ["5", "Which actors were born in Germany?", ['Q10800557', 'Q183'], []],
    ["6", "Does the Isar flow into a lake?", ['Q106588'], []],
    ["7", "Which writers studied in Istanbul?", ['Q406', 'Q36180'], []],
    ["8", "Which mountain is the highest after the Annapurna?", ['Q16466024'], []],
    ["9", "Are tree frogs a type of amphibian?", ['Q10908', 'Q53696'], []],
    ["10", "In which city did John F. Kennedy die?", ['Q9696'], []],
    ["11", "Is Lake Baikal bigger than the Great Bear Lake?", ['Q5525', 'Q5513'], []],
    ["12", "Was the Cuban Missile Crisis earlier than the Bay of Pigs Invasion?", ['Q191721', 'Q128160'], []],
    ["13", "which country has the most official languages ?", [], []],
    ["14", "where did sir john a macdonald die ?", ["Q128702"], []]
];

const isSubset = (superset : string[], subset : string[]) => subset.every((item : string) => superset.includes(item));

async function main() {
    console.log("Checking GPT-3 Linker");
    const wikidata = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const gptLinker = new GPT3Linker(wikidata, { ner_cache: 'gpt3-ned.sqlite' });
    let gptCorrect = 0;
    for (const [id, utterance, expectedEntities, expectedRelations] of TEST_CASES) {
        console.log(`Beginning test ${id}`);
        const result = await gptLinker.run(id as string, utterance as string);
        const entities = result.entities.map((e : any) => e.id);
        try {
            assert.ok(isSubset(entities, expectedEntities as string[]));
            assert.ok(isSubset(result.relations.map((r : any) => r.id), expectedRelations as string[]));
            console.log(`Test ${id} passed`);
            gptCorrect += 1;
        } catch(AssertionError) {
            console.log(`Test ${id} failed. Expected ${expectedEntities} and got ${new Array(...entities).join(', ')}. This means it found [ "${result.entities.map((e : any) => e.label).join('", "')}" ] in ${utterance}`);
        }
    }
    console.log(`GPT-3 gets ${(gptCorrect / TEST_CASES.length) * 100}% (${gptCorrect}/${TEST_CASES.length}) of test cases correct\n\n`);

    console.log("Checking Falcon Linker");
    const falconLinker = new Falcon(wikidata, { ner_cache: 'falcon-ned.sqlite' });
    let falconCorrect = 0;
    for (const [id, utterance, expectedEntities, expectedRelations] of TEST_CASES) {
        const result = await falconLinker.run(id as string, utterance as string);
        const entities = result.entities.map((e : any) => e.id);
        try {
            assert.ok(isSubset(entities, expectedEntities as string[]));
            assert.ok(isSubset(result.relations.map((r : any) => r.id), expectedRelations as string[]));
            console.log(`Test ${id} passed`);
            falconCorrect += 1;
        } catch(AssertionError) {
            console.log(`Test ${id} failed. Expected ${expectedEntities} and got ${new Array(...entities).join(', ')}. This means it found [ "${result.entities.map((e : any) => e.label).join('", "')}" ] in ${utterance}`);
        }
    }
    console.log(`Falcon gets ${(falconCorrect / TEST_CASES.length) * 100}% (${falconCorrect}/${TEST_CASES.length}) of test cases correct`);

    // console.log("Checking Azure Linker");
    // const azureLinker = new AzureEntityLinker(wikidata, { ner_cache: 'azure-ned.sqlite' });
    // let azureCorrect = 0;
    // for (const [id, utterance, expectedEntities, expectedRelations] of TEST_CASES) {
    //     const result = await azureLinker.run(id as string, utterance as string);
    //     const entities = new Set(result.entities.map((e : any) => e.id));
    //     try {
    //         assert.deepStrictEqual(entities, new Set(expectedEntities));
    //         assert.deepStrictEqual(result.relations.map((r : any) => r.id), expectedRelations);
    //         console.log(`Test ${id} passed`);
    //         azureCorrect += 1;
    //     } catch(AssertionError) {
    //         console.log(`Test ${id} failed. Expected ${expectedEntities} and got ${new Array(...entities).join(', ')}. This means it found "${result.entities.map((e : any) => e.label).join(', ')}" in ${utterance}`);
    //     }
    // }
    // console.log(`Azure gets ${(azureCorrect / TEST_CASES.length) * 100}% of test cases correct`);
}

main();
