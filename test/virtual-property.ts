import assert from 'assert';
import WikidataUtils from "../lib/utils/wikidata";
import VirtualPropertyGenerator from '../lib/converter/helpers/virtual-property';

/* TEST_CASES entry pattern:
QID of entity
Filename that stores virtual properties
Virtual property to use
JSON encoded ordering (JSON encoded because it keeps the types present in the array consistent, which avoids a type error that I'm not skilled enough at TypeScript to solve easily so just worked around for now)
*/
const TEST_CASES = [
    [
        'Q157376', 
        "virtual_property_order.json", 
        'location', 
        'where do the golden state warriors play ?', 
        `[
            "headquarters location",
            "country",
            "home venue"
        ]`
    ],
    [
        'Q4856037', 
        "virtual_property_order.json", 
        'location', 
        'where is the bank of america pavilion ?', 
        `[
            "located in the administrative territorial entity",
            "location",
            "country"
        ]`
    ],
    [
        'Q12560', 
        "virtual_property_order.json", 
        'location', 
        'where is the ottoman empire located ?', 
        `[
            "country",
            "continent",
            "locator map image"
        ]`
    ],
    [
        'Q317308', 
        "virtual_property_order.json", 
        'location', 
        'where is devon sawa now ?', 
        `[
            "place of birth",
            "country of citizenship"
        ]`
    ],
    [
        'Q2277', 
        "virtual_property_order.json", 
        'location', 
        'where was the roman empire centered ?', 
        `[
            "located in the administrative territorial entity",
            "location",
            "residence",
            "country of origin",
            "place of birth",
            "country of citizenship",
            "capital of",
            "country",
            "continent",
            "applies to jurisdiction",
            "location of creation",
            "place of publication",
            "place of death",
            "locator map image",
            "narrative location"
        ]`
    ]
];

async function main() { 
    const wikidataUtils = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const virtualPropertyGenerator = new VirtualPropertyGenerator(wikidataUtils);
    // Non-GPT-3 test cases
    for (const [entity, abstractionFile, virtualProperty, utterance, output] of TEST_CASES) {
        console.log(`Checking properties for ${entity} with heuristic search`);
        const propertyList = await virtualPropertyGenerator.getPropertiesForVirtualProperty(
            abstractionFile,
            entity,
            virtualProperty,
            utterance,
            false
        );
        assert.deepEqual(propertyList, JSON.parse(output));
    }
    // GPT-3 test cases
    // for (const [entity, abstractionFile, virtualProperty, utterance, output] of TEST_CASES) {
    //     console.log(`Checking properties for ${entity} with GPT-3 search`);
    //     const propertyList = await virtualPropertyGenerator.getPropertiesForVirtualProperty(
    //         abstractionFile,
    //         entity,
    //         virtualProperty,
    //         utterance,
    //         true
    //     );
    //     assert.strictEqual(propertyList, JSON.parse(output)[0]);
    // }
}

main();