import * as fs from 'fs';
import csvparse from 'csv-parse';
import * as argparse from 'argparse';
import { ThingTalkUtils } from 'genie-toolkit';
import { Ast, Syntax } from 'thingtalk';
import { waitFinish } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { StreamUtils, EntityUtils } from 'genie-toolkit';

class unresolvedEntityFinder extends Ast.NodeVisitor {
    unresolvedEntities : Ast.EntityValue[];

    constructor() {
        super();
        this.unresolvedEntities = [];
    }

    visitEntityValue(node : Ast.EntityValue) : boolean {
        if (node.value === null)
            this.unresolvedEntities.push(node);
        return true;
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Evaluate the answer accuracy"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: 'utc',
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });

    parser.add_argument('--oracle', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('--prediction', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--save-cache', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('-o', '--output', {
        required: true
    });

    const args = parser.parse_args();
    const wikidata = new WikidataUtils(args.cache, args.bootleg_db, args.save_cache);
    const expectedThingTalk : Record<string, string> = {};
    const predictedThingTalk : Record<string, string> = {};
    const oracle = args.oracle.pipe(csvparse({ columns: ['id', 'sentence', 'thingtalk'], delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const oracleData = await oracle.read(); 
    for (const ex of oracleData.values()) 
        expectedThingTalk[ex.id] = ex.thingtalk;

    const prediction = args.prediction.pipe(csvparse({ columns: ['id', 'sentence', 'thingtalk', 'prediction'], delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const predictedData = await prediction.read();

    let total = 0;
    let exact_match = 0;
    const debug = [];
    
    for (const ex of predictedData.values()) {
        const tokens = ex.sentence.split(' ');
        const entities = EntityUtils.makeDummyEntities(ex.sentence);
        try {
            const parsed = Syntax.parse(ex.prediction, Syntax.SyntaxType.Tokenized, entities, {
                locale : args.locale, timezone: args.timezone
            });
            const finder = new unresolvedEntityFinder();
            parsed.visit(finder);
            for (const entity of finder.unresolvedEntities) {
                if (!entity.display) {
                    console.log('Missing display for entity: ' + entity);
                    continue;
                }
                const qid = await wikidata.getEntityByName(entity.display);
                if (!qid) {
                    console.log('Failed to find QID for: ' + entity.display);
                    continue;
                }
                entity.value = qid;
            }
            const thingtalk = ThingTalkUtils.serializePrediction(parsed!, tokens, entities, {
                locale: args.locale,
                timezone: args.timezone,
                includeEntityValue: true,
                excludeEntityDisplay: true
            }).join(' ');
            predictedThingTalk[ex.id] = thingtalk;
        } catch(e) {
            console.log(e);
            predictedThingTalk[ex.id] = ex.prediction;
        }
        total += 1;
        if (expectedThingTalk[ex.id] === predictedThingTalk[ex.id])
            exact_match += 1;
        else 
            debug.push([ex.id, ex.sentence, expectedThingTalk[ex.id], predictedThingTalk[ex.id]].join('\t'));
    }
    fs.writeFileSync(args.output, debug.join('\n'));

    console.log('Exact match: ' + exact_match);
    console.log('Total: ' + total);
    console.log('Accuracy: ' + exact_match / total);
   
    
    await waitFinish(oracle);
    await waitFinish(prediction);
}

if (require.main === module)
    main();