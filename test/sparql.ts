import assert from 'assert';
import { WikidataUtils } from "../lib";


const TESTS : Array<[string, string[]]>= [
    [
        `SELECT DISTINCT ?x WHERE { 
            ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q47461344>. 
            ?x <http://www.wikidata.org/prop/direct/P50> <http://www.wikidata.org/entity/Q1035>. 
        }`,
        [
            'Q375946',   'Q785958',    'Q917790',
            'Q941356',   'Q1165434',   'Q1192325',
            'Q1755867',  'Q1801903',   'Q2001494',
            'Q4354654',  'Q5172902',   'Q5535306',
            'Q5535307',  'Q7730156',   'Q7731618',
            'Q7747177',  'Q7767074',   'Q15632042',
            'Q17113957', 'Q17141164',  'Q19020082',
            'Q29031802', 'Q41762310',  'Q51285024',
            'Q20124',    'Q108913947', 'Q51514226',
            'Q56101460', 'Q56104290',  'Q56141235',
            'Q56160394', 'Q56288566',  'Q61661293',
            'Q71933415', 'Q84467715'
        ]
    ], 
    [
        `SELECT DISTINCT ?x WHERE { 
            ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q570116>. 
            ?x <http://www.wikidata.org/prop/direct/P131>+ <http://www.wikidata.org/entity/Q2256>. 
        }`,
        [
            'Q248555',   'Q4916760',
            'Q5330951',  'Q5945554',
            'Q6941014',  'Q6978303',
            'Q6488462',  'Q7784619',
            'Q7861738',  'Q19191139',
            'Q15945108'
        ]
    ]
];


async function main() {
    const wikidata = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    for (const [sparql, expectedAnswer] of TESTS) {
        const results = await wikidata.query(sparql);
        assert(results.length === expectedAnswer.length && results.every((entity) => expectedAnswer.includes(entity)));
    } 
}

main();